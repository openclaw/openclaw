import { describe, expect, it, vi } from "vitest";
import { createAbortError } from "../infra/abort-signal.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

import { sessionsCompactCommand } from "./sessions-compact.js";

function createRun() {
  const captured = createCapturingTestRuntime();
  return {
    ...captured,
    run: (): Promise<void> => sessionsCompactCommand({ key: "agent:main:main" }, captured.runtime),
  };
}

describe("sessions compact command", () => {
  it("keeps the canonical abort outcome instead of reporting a cancelled compaction", async () => {
    const { run, logs, errors } = createRun();
    const scope = new AsyncWorkScope();
    const reason = new Error("sessions compact interrupted");
    mocks.callGateway.mockImplementation(async () => {
      scope.beginClose(reason);
      throw createAbortError("gateway request aborted for sessions.compact");
    });

    await expect(scope.run(run)).rejects.toBe(reason);
    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
    await scope.drain();
  });

  it("still reports a genuine compaction failure and exits nonzero", async () => {
    const { run, errors } = createRun();
    mocks.callGateway.mockRejectedValue(new Error("compaction backend unavailable"));

    await run();

    expect(errors).toEqual(["Compaction failed: compaction backend unavailable"]);
  });
});
