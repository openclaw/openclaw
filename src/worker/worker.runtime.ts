import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  buildWorkerConnectParams,
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "./launch-descriptor.js";
import { createWorkerConnection, type WorkerConnectionState } from "./worker-connection.js";
import {
  WorkerInferenceProxyClient,
  WorkerLiveEventClient,
  WorkerTranscriptCommitClient,
} from "./worker-rpc-clients.js";

export type WorkerRuntimeResult =
  | { status: "completed"; transcriptLeafId: string | null; transcriptNextSeq: number }
  | { status: "fenced"; reason: "credential-replaced" | "owner-epoch-mismatch" };

export type RunWorkerCommandOptions = {
  input: Readable;
  output: Writable;
};

const WORKER_REMOTE_CANCEL_GRACE_MS = 1_000;

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

async function readLaunchDescriptor(input: Readable): Promise<WorkerLaunchDescriptor> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const rawChunk of input as AsyncIterable<unknown>) {
    const chunk =
      typeof rawChunk === "string"
        ? Buffer.from(rawChunk)
        : rawChunk instanceof Uint8Array
          ? Buffer.from(rawChunk)
          : undefined;
    if (!chunk) {
      throw new Error("worker launch descriptor input must be bytes");
    }
    byteLength += chunk.byteLength;
    if (byteLength > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
      throw new Error("worker launch descriptor exceeds the protocol payload limit");
    }
    chunks.push(chunk);
  }
  if (byteLength === 0) {
    throw new Error("worker launch descriptor is required on stdin");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("worker launch descriptor is not valid JSON", { cause: error });
  }
  return parseWorkerLaunchDescriptor(decoded);
}

function fencedResult(state: WorkerConnectionState): WorkerRuntimeResult | undefined {
  if (
    state.kind === "fenced" &&
    (state.reason === "credential-replaced" || state.reason === "owner-epoch-mismatch")
  ) {
    return { status: "fenced", reason: state.reason };
  }
  return undefined;
}

async function assertWorkspaceDirectory(workspaceDir: string): Promise<string> {
  const resolved = await realpath(workspaceDir);
  const workspaceStat = await stat(resolved);
  if (!workspaceStat.isDirectory()) {
    throw new Error("worker workspace path must be a directory");
  }
  return resolved;
}

export async function runWorkerDescriptor(
  descriptor: WorkerLaunchDescriptor,
  options: { signal?: AbortSignal } = {},
): Promise<WorkerRuntimeResult> {
  const workspaceDir = await assertWorkspaceDirectory(descriptor.assignment.workspaceDir);
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-worker-"));
  await chmod(stateDir, 0o700);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");

  const abortController = new AbortController();
  let turnStarted = false;
  let forcedStopTimer: NodeJS.Timeout | undefined;
  const connection = createWorkerConnection({
    socketPath: descriptor.socketPath,
    connectParams: buildWorkerConnectParams(descriptor),
  });
  const abortFromCaller = () => {
    abortController.abort(options.signal?.reason);
    if (!turnStarted) {
      void connection.stop();
      return;
    }
    forcedStopTimer = setTimeout(() => {
      void connection.stop();
    }, WORKER_REMOTE_CANCEL_GRACE_MS);
    forcedStopTimer.unref();
  };
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) {
    abortFromCaller();
  }
  const transcript = new WorkerTranscriptCommitClient(connection, {
    runEpoch: descriptor.admission.ownerEpoch,
    baseLeafId: descriptor.assignment.transcript.baseLeafId,
    initialSeq: descriptor.assignment.transcript.nextSeq,
  });
  const live = new WorkerLiveEventClient(connection, {
    runEpoch: descriptor.admission.ownerEpoch,
    initialAckedSeq: descriptor.assignment.liveEvents.ackedSeq,
  });
  const inference = new WorkerInferenceProxyClient(connection);
  const unsubscribeState = connection.onStateChange((state) => {
    if (state.kind === "fenced") {
      abortController.abort(new Error(`worker fenced: ${state.reason}`));
    } else if (state.kind === "failed") {
      abortController.abort(state.error);
    }
  });

  try {
    try {
      await connection.start();
    } catch (error) {
      const fenced = fencedResult(connection.state);
      if (fenced) {
        return fenced;
      }
      throw error;
    }
    const [{ runWorkerEmbeddedTurn }, { createWorkerInferenceStreamAdapter }] = await Promise.all([
      import("./embedded-agent.runtime.js"),
      import("./inference-stream.runtime.js"),
    ]);
    const stream = createWorkerInferenceStreamAdapter({
      client: inference,
      sessionId: descriptor.admission.sessionId,
      runEpoch: descriptor.admission.ownerEpoch,
      runId: descriptor.assignment.runId,
      turnId: descriptor.assignment.turnId,
      modelRef: descriptor.assignment.modelRef,
    });
    try {
      turnStarted = true;
      await runWorkerEmbeddedTurn({
        cwd: workspaceDir,
        stateDir,
        sessionId: descriptor.admission.sessionId,
        sessionKey: `worker:${descriptor.admission.sessionId}`,
        runId: descriptor.assignment.runId,
        prompt: descriptor.assignment.prompt,
        modelRef: descriptor.assignment.modelRef,
        initialMessages: descriptor.assignment.initialMessages,
        ...(descriptor.assignment.systemPrompt === undefined
          ? {}
          : { systemPrompt: descriptor.assignment.systemPrompt }),
        inferenceOptions: descriptor.assignment.inferenceOptions,
        inference: { stream },
        transcript: {
          commit: async (messages) => {
            await transcript.commit(messages);
          },
        },
        live: {
          emit: async (event) => {
            await live.emit(descriptor.assignment.runId, event);
          },
        },
        signal: abortController.signal,
      });
      if (options.signal?.aborted) {
        throw toError(options.signal.reason, "worker interrupted");
      }
    } catch (error) {
      const fenced = fencedResult(connection.state);
      if (fenced) {
        return fenced;
      }
      throw toError(error, "worker session failed");
    }
    const fenced = fencedResult(connection.state);
    if (fenced) {
      return fenced;
    }
    if (connection.state.kind === "failed") {
      throw connection.state.error;
    }
    return {
      status: "completed",
      transcriptLeafId: transcript.baseLeafId,
      transcriptNextSeq: transcript.nextSeq,
    };
  } finally {
    if (forcedStopTimer) {
      clearTimeout(forcedStopTimer);
    }
    unsubscribeState();
    options.signal?.removeEventListener("abort", abortFromCaller);
    inference.dispose();
    live.dispose();
    await connection.stop();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
}

export async function runWorkerCommand(options: RunWorkerCommandOptions): Promise<void> {
  const descriptor = await readLaunchDescriptor(options.input);
  const abortController = new AbortController();
  const stop = () => abortController.abort(new Error("worker interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runWorkerDescriptor(descriptor, { signal: abortController.signal });
    const encoded = `${JSON.stringify(result)}\n`;
    options.output.write(encoded);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
