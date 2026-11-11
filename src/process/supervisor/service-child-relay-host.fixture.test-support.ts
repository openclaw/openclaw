import type { ChildProcess } from "node:child_process";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { firstMockArg } from "./adapters/child.test-support.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorPayload,
} from "./service-child-protocol.js";
import { createWritableRelayChild } from "./service-child-relay-host.test-support.js";

export const relayDefaults = {
  command: "synthetic-command",
  args: [],
  stdinMode: "pipe-closed" as const,
  oomScoreWrapperSelected: false,
};

export function mockWritableRelay(
  configureSpawn: (child: ChildProcess) => void,
  platform: "linux" | "darwin" = "darwin",
) {
  mockProcessPlatform(platform);
  const killSpy =
    platform === "linux"
      ? vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === 0 && signal === 0) {
            return true;
          }
          throw Object.assign(new Error("fixture group absent"), { code: "ESRCH" });
        })
      : undefined;
  const stub = createWritableRelayChild();
  configureSpawn(stub.child);
  return { ...stub, killSpy };
}

export function relayPeer(stub: ReturnType<typeof createWritableRelayChild>) {
  const start = firstMockArg(stub.sendMock, "service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("Expected an admitted service generation");
  }
  const generation = start.generation;
  let sequence = 0;
  return {
    start,
    emit: (payload: ServiceChildAnchorPayload) =>
      stub.control.push(
        Buffer.from(
          encodeServiceChildMessage({
            ...(payload.type === "ready" && start.treeOwnership === "linux-subreaper"
              ? { treeOwnership: "linux-subreaper" as const }
              : {}),
            ...(payload.type === "closing" && start.treeOwnership === "linux-subreaper"
              ? { descendantsReaped: true as const }
              : {}),
            ...payload,
            generation,
            sequence: ++sequence,
          }),
        ),
      ),
  };
}

export function closeStub(stub: ReturnType<typeof createWritableRelayChild>) {
  stub.control.destroy();
  stub.lineage.destroy();
  stub.disconnectMock();
  stub.emitExit(0);
}

export function observeSettlement<T>(promise: Promise<T>) {
  const settled = vi.fn();
  void promise.then(settled, settled);
  return [promise, settled] as const;
}
