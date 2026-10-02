import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawGatewayPlanChangedError } from "./gateway-add-apply.js";
import { projectClawRemovePlan } from "./gateway-plan-projection.js";
import { applyClawRemoveForGateway } from "./gateway-remove-apply.js";
import type { ClawRemovePlan } from "./lifecycle-remove-contract.js";
import type { ClawMonitorCleanupGateway } from "./monitor-cleanup-contract.js";

const planClawRemoveForGateway = vi.hoisted(() => vi.fn());
const runClawRemoveCli = vi.hoisted(() => vi.fn());
vi.mock("./gateway-lifecycle-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-lifecycle-plan.js")>()),
  planClawRemoveForGateway,
}));
vi.mock("./gateway-remove-cli.js", () => ({ runClawRemoveCli }));

const canonical: ClawRemovePlan = {
  schemaVersion: "openclaw.clawRemovePlan.v1",
  stability: "experimental",
  dryRun: true,
  mutationAllowed: false,
  planIntegrity: `sha256:${"a".repeat(64)}`,
  target: "worker",
  agentId: "worker",
  actions: [
    {
      kind: "agent",
      id: "worker",
      action: "remove",
      target: "worker",
      blocked: false,
      details: { privateToken: "keep-out-of-browser" },
    },
  ],
  blockers: [],
};
const preview = projectClawRemovePlan(canonical, {
  name: "@openclaw/workflow-operator",
  version: "1.0.0",
});
const monitorGateway: ClawMonitorCleanupGateway = {
  inspect: vi.fn(async () => []),
  quiesce: vi.fn(async () => {}),
  drain: vi.fn(async () => {}),
};
const complete = {
  schemaVersion: "openclaw.clawRemoveResult.v1",
  stability: "experimental",
  dryRun: false,
  status: "complete",
  agentId: "worker",
  agentRemoved: true,
  workspaceFiles: [],
  packages: [],
  mcpServers: [],
  cronJobs: [],
  packageRefsReleased: 0,
};

function input(overrides: Partial<Parameters<typeof applyClawRemoveForGateway>[0]> = {}) {
  return {
    agentId: "worker",
    planIntegrity: preview.planIntegrity,
    getRuntimeConfig: () => ({}),
    monitorGateway,
    assertCurrent: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Gateway Claw Remove Apply", () => {
  it("uses the exact CLI plan after the sealed Gateway review and strips private result fields", async () => {
    planClawRemoveForGateway.mockResolvedValue(preview);
    runClawRemoveCli
      .mockResolvedValueOnce({ code: 0, payload: canonical })
      .mockResolvedValueOnce({ code: 0, payload: { ...complete, privateToken: "never-return" } });

    const result = await applyClawRemoveForGateway(input());

    expect(result).toEqual({ agentId: "worker", status: "complete", agentRemoved: true });
    expect(planClawRemoveForGateway).toHaveBeenCalledWith({
      agentId: "worker",
      config: {},
      monitorGateway,
    });
    expect(runClawRemoveCli.mock.calls).toEqual([
      [{ agentId: "worker", signal: undefined }],
      [{ agentId: "worker", planIntegrity: canonical.planIntegrity }],
    ]);
  });

  it("rejects stale UI review and changed CLI facts before launching Apply", async () => {
    planClawRemoveForGateway.mockResolvedValue(preview);
    await expect(
      applyClawRemoveForGateway(input({ planIntegrity: `sha256:${"b".repeat(64)}` })),
    ).rejects.toBeInstanceOf(ClawGatewayPlanChangedError);
    expect(runClawRemoveCli).not.toHaveBeenCalled();

    runClawRemoveCli.mockResolvedValueOnce({
      code: 0,
      payload: { ...canonical, planIntegrity: `sha256:${"c".repeat(64)}` },
    });
    await expect(applyClawRemoveForGateway(input())).rejects.toBeInstanceOf(
      ClawGatewayPlanChangedError,
    );
    expect(runClawRemoveCli).toHaveBeenCalledTimes(1);
  });

  it("does not launch Apply after authority is revoked during dry-run", async () => {
    let authorized = true;
    planClawRemoveForGateway.mockResolvedValue(preview);
    runClawRemoveCli.mockImplementationOnce(async () => {
      authorized = false;
      return { code: 0, payload: canonical };
    });
    await expect(
      applyClawRemoveForGateway(
        input({
          assertCurrent: () => {
            if (!authorized) {
              throw new Error("revoked");
            }
          },
        }),
      ),
    ).rejects.toThrow("revoked");
    expect(runClawRemoveCli).toHaveBeenCalledTimes(1);
  });

  it("returns only a safe partial message for a partial or unknown child outcome", async () => {
    planClawRemoveForGateway.mockResolvedValue(preview);
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: canonical }).mockResolvedValueOnce({
      code: 1,
      payload: {
        ...complete,
        status: "partial",
        error: { code: "package_cleanup_failed", message: "token=secret" },
      },
    });
    expect(await applyClawRemoveForGateway(input())).toEqual({
      agentId: "worker",
      status: "partial",
      agentRemoved: true,
      error: {
        code: "remove_partial",
        message: "Claw removal is incomplete. Review its status before retrying.",
      },
    });

    runClawRemoveCli
      .mockResolvedValueOnce({ code: 0, payload: canonical })
      .mockRejectedValueOnce(new Error("token=secret"));
    expect(await applyClawRemoveForGateway(input())).toEqual({
      agentId: "worker",
      status: "partial",
      agentRemoved: false,
      error: {
        code: "remove_outcome_uncertain",
        message: "Claw state may have changed. Review its status before retrying.",
      },
    });
  });
});
