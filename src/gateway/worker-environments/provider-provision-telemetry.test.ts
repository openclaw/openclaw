import { describe, expect, it, vi } from "vitest";
import type { WorkerEnvironmentRecord } from "./store.js";

const entries = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({
    info: (_message: string, meta: Record<string, unknown>) => entries.push(meta),
    warn: (_message: string, meta: Record<string, unknown>) => entries.push(meta),
  }),
}));

import { withWorkerProvisionStage } from "./provider-provision-telemetry.js";

describe("Gateway worker provisioning telemetry", () => {
  it("correlates a failed stage and excludes raw error contents", async () => {
    entries.length = 0;
    const record = {
      environmentId: "worker-1",
      provisionOperationId: "operation-1",
      leaseId: null,
      attachedSessionIds: [],
    } satisfies Pick<
      WorkerEnvironmentRecord,
      "environmentId" | "provisionOperationId" | "leaseId" | "attachedSessionIds"
    >;
    await expect(
      withWorkerProvisionStage(
        record,
        "node-bundle-install",
        async () => {
          throw new Error("Bearer secret-value");
        },
        "cbx_1",
      ),
    ).rejects.toThrow("Bearer secret-value");
    expect(entries).toMatchObject([
      {
        environmentId: "worker-1",
        provisionOperationId: "operation-1",
        leaseId: "cbx_1",
        sessionId: null,
        stage: "node-bundle-install",
        outcome: "started",
        elapsedMs: 0,
      },
      {
        environmentId: "worker-1",
        provisionOperationId: "operation-1",
        leaseId: "cbx_1",
        sessionId: null,
        stage: "node-bundle-install",
        outcome: "failed",
        errorCode: "Error",
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret-value");
  });
});
