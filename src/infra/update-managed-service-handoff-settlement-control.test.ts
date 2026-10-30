import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  observeManagedServiceUpdateHandoffClose,
  SYSTEM_SERVICE_UPDATE_SETTLED_MARKER,
} from "./update-managed-service-handoff-service.js";
import type { ActiveManagedServiceUpdateHandoff } from "./update-managed-service-handoff-types.js";

it.each([
  { code: 0, signal: null, receipt: false, settled: false },
  { code: 7, signal: null, receipt: false, settled: false },
  { code: 143, signal: null, receipt: false, settled: false },
  { code: null, signal: "SIGTERM", receipt: false, settled: false },
  { code: null, signal: "SIGKILL", receipt: true, settled: false },
  { code: 0, signal: null, receipt: true, settled: true },
  { code: 7, signal: null, receipt: true, settled: true },
] as const)(
  "joins receipt and close without inferring cleanup from exit ($code, $signal, $receipt)",
  async ({ code, signal, receipt, settled }) => {
    const child = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: code,
      signalCode: signal,
    });
    const owner: ActiveManagedServiceUpdateHandoff = {
      handoffId: "fixture",
      parentExitTimeoutMs: 1,
      recoveryTimeoutMs: 1,
    };
    // A transport-only child fixture; the companion regression runs the actual helper.
    const closed = observeManagedServiceUpdateHandoffClose(owner, child);
    if (receipt) {
      child.stdout.write(SYSTEM_SERVICE_UPDATE_SETTLED_MARKER.slice(0, 8));
      child.stdout.write(SYSTEM_SERVICE_UPDATE_SETTLED_MARKER.slice(8));
    }
    expect(owner.settled).toBeUndefined();
    child.emit("close", code, signal);
    await closed;
    expect(owner.settled).toBe(settled);
    expect(child.stdout.listenerCount("data")).toBe(0);
    child.stdin.destroy();
    child.stdout.destroy();
  },
);
