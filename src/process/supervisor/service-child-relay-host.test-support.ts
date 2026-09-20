import type { ChildProcess } from "node:child_process";
import { Duplex, PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { createStubChild, firstMockArg } from "./adapters/child.test-support.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorPayload,
  type ServiceChildControlMessage,
} from "./service-child-protocol.js";
import { createServiceChildRelayAdapter as startServiceChildRelayAdapter } from "./service-child-relay-host.js";

// Direct factory assertions concern completed readiness; caller regressions
// below consume the production split startup directly.
export async function createServiceChildRelayAdapter(
  params: Parameters<typeof startServiceChildRelayAdapter>[0],
) {
  const { adapter, ready } = await startServiceChildRelayAdapter(params);
  await ready;
  return adapter;
}

export async function createRelayFixture(
  platform: "linux" | "darwin" | "win32",
  retainLineage: boolean,
  configureSpawn: (child: ChildProcess) => void,
  onCleanup: (cleanup: () => void) => void,
) {
  const groupProbe = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("synthetic missing process group"), { code: "ESRCH" });
  });
  const stub = createStubChild();
  const cancellations: Array<(error: Error) => void> = [];
  const acknowledgements: ServiceChildControlMessage[] = [];
  // Keep channel closure independently controlled from cancellation write completion.
  const control = new Duplex({
    autoDestroy: false,
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      // SAFETY: this exact adapter is the sole writer on its private control channel.
      const message = JSON.parse(chunk.toString()) as ServiceChildControlMessage;
      if (message.type === "cancel") {
        cancellations.push(callback);
      } else {
        acknowledgements.push(message);
        callback();
      }
    },
  });
  const lineage = new PassThrough();
  Object.defineProperty(stub.child, "stdio", {
    value: [stub.child.stdin, stub.child.stdout, stub.child.stderr, control, lineage],
    configurable: true,
  });
  if (platform === "win32") {
    stub.child.stdout = null;
    stub.child.stderr = null;
  }
  configureSpawn(stub.child);
  const starting = createServiceChildRelayAdapter({
    command: "synthetic-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
    ...(platform === "win32" ? { windowsShellCommand: "synthetic-command" } : {}),
  });
  const start = firstMockArg(stub.sendMock, "service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("Expected an admitted service generation");
  }
  const generation = start.generation;
  let sequence = 0;
  const emit = (payload: ServiceChildAnchorPayload) => {
    const message = { ...payload, generation, sequence: ++sequence };
    if (platform === "win32") {
      stub.child.emit("message", message);
    } else {
      control.push(Buffer.from(encodeServiceChildMessage(message)));
    }
    return message;
  };
  emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
  const adapter = await starting;
  if (platform === "win32") {
    stub.sendMock.mockImplementation((_message, ...args) => {
      const callback = args.find(
        (value): value is (error: Error) => void => typeof value === "function",
      );
      if (!callback) {
        throw new Error("Expected a cancellation delivery callback");
      }
      cancellations.push(callback);
      return true;
    });
  }
  const endOutput = () => {
    if (platform === "win32") {
      emit({ type: "output-end", stream: "stdout" });
      emit({ type: "output-end", stream: "stderr" });
    } else {
      stub.child.stdout?.emit("end");
      stub.child.stderr?.emit("end");
    }
  };
  const completeRoot = () => {
    emit({ type: "root-result", code: 0, signal: null });
    endOutput();
  };
  const closeControl = () => control.destroy();
  const exitRelay = () => {
    if (!retainLineage) {
      lineage.end();
    }
    stub.disconnectMock();
    stub.emitExit(0);
  };
  const close = () => {
    closeControl();
    exitRelay();
  };
  const floodControl = (chunk: string | Buffer) => {
    control.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  const controlEncoding = () => control.readableEncoding;
  const killSpy = vi.spyOn(stub.child, "kill");
  onCleanup(() => {
    close();
    lineage.destroy();
  });
  return {
    adapter,
    start,
    cancellations,
    acknowledgements,
    acknowledgeRetirement: () => {
      const request = stub.sendMock.mock.calls.at(-1)?.[0];
      if (!isRecord(request) || request.type !== "cancel") {
        throw new Error("Expected the relay retirement request");
      }
      stub.child.emit("message", {
        type: "retirement",
        generation,
        sequence: request.sequence,
        anchorExited: true,
      });
    },
    emit,
    completeRoot,
    endOutput,
    close,
    closeControl,
    exitRelay,
    floodControl,
    controlEncoding,
    killSpy,
    groupProbe,
    lineage,
    stdout: stub.child.stdout,
    stderr: stub.child.stderr,
  };
}
