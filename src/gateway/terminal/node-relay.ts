import { NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS } from "../../infra/node-commands.js";
import type { NodeRegistry, NodeInvokeResult } from "../node-registry.js";
import type { TerminalBackend, TerminalBackendExit } from "./backend.js";

const DATA_INPUT_CHUNK_BYTES = 2 * 1024;

function parseExit(result: NodeInvokeResult): TerminalBackendExit {
  if (!result.ok) {
    const code = result.error?.code ?? "NODE_INVOKE_FAILED";
    const message = result.error?.message ?? "node terminal invoke failed";
    return { error: `${code}: ${message}` };
  }
  try {
    const raw =
      result.payloadJSON ??
      (result.payload === undefined ? undefined : JSON.stringify(result.payload));
    if (!raw) {
      return { exitCode: 0 };
    }
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { exitCode: 0 };
    }
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
      ...(typeof record.signal === "number" ? { signal: record.signal } : {}),
    };
  } catch {
    return { error: "node terminal returned an invalid exit result" };
  }
}

function splitInput(data: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < data.length; index += 1) {
    const codePoint = data.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    const size = Buffer.byteLength(char, "utf8");
    if (bytes > 0 && bytes + size > DATA_INPUT_CHUNK_BYTES) {
      chunks.push(data.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    if (char.length === 2) {
      index += 1;
    }
  }
  if (start < data.length) {
    chunks.push(data.slice(start));
  }
  return chunks;
}

export async function createNodeRelayBackend(params: {
  registry: NodeRegistry;
  nodeId: string;
  command: string;
  params: Record<string, unknown>;
}): Promise<TerminalBackend> {
  let invokeId: string | undefined;
  let dataCallback: ((data: string) => void) | undefined;
  let exitCallback: ((exit: TerminalBackendExit) => void) | undefined;
  const pendingData: string[] = [];
  let pendingExit: TerminalBackendExit | undefined;
  const abort = new AbortController();
  const result = params.registry
    .invoke({
      nodeId: params.nodeId,
      command: params.command,
      params: params.params,
      timeoutMs: 0,
      idleTimeoutMs: NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
      signal: abort.signal,
      onInvokeId: (id) => {
        invokeId = id;
      },
      onProgress: (chunk) => {
        if (!chunk) {
          return;
        }
        if (dataCallback) {
          dataCallback(chunk);
        } else {
          pendingData.push(chunk);
        }
      },
    })
    .then(parseExit)
    .catch(
      (error: unknown): TerminalBackendExit => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((exit) => {
      if (exitCallback) {
        exitCallback(exit);
      } else {
        pendingExit = exit;
      }
      return exit;
    });
  // NodeRegistry invokes onInvokeId synchronously after a successful send, before its first await.
  // Failure paths resolve the result instead; keeping that callback synchronous is load-bearing.
  await Promise.resolve();
  if (!invokeId) {
    const exit = await result;
    throw new Error(exit.error ?? "failed to start node terminal invoke");
  }
  const activeInvokeId = invokeId;
  const send = (payload: unknown) => params.registry.sendInvokeInput(activeInvokeId, payload);
  return {
    write(data) {
      for (const chunk of splitInput(data)) {
        send({ kind: "data", data: chunk });
      }
    },
    resize(cols, rows) {
      send({ kind: "resize", cols, rows });
    },
    kill() {
      abort.abort();
    },
    onData(callback) {
      dataCallback = callback;
      for (const chunk of pendingData.splice(0)) {
        callback(chunk);
      }
    },
    onExit(callback) {
      exitCallback = callback;
      if (pendingExit) {
        const exit = pendingExit;
        pendingExit = undefined;
        callback(exit);
      }
    },
  };
}
