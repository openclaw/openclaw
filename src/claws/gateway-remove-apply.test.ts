import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawGatewayPlanChangedError } from "./gateway-add-apply.js";
import { projectClawRemovePlan } from "./gateway-plan-projection.js";
import { applyClawRemoveForGateway } from "./gateway-remove-apply.js";
import { digestClawRemovePlanIdentity, type ClawRemovePlan } from "./lifecycle-remove-contract.js";
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
canonical.planIntegrity = digestClawRemovePlanIdentity(canonical);
const preview = projectClawRemovePlan(canonical, {
  name: "@openclaw/workflow-operator",
  version: "1.0.0",
});
const monitorGateway: ClawMonitorCleanupGateway = {
  inspect: vi.fn(async () => []),
  quiesce: vi.fn(async () => {}),
  drain: vi.fn(async () => {}),
};
const packageGateway = vi.fn(async () => ({ packages: [] }));
const cronGateway = { get: vi.fn(async () => null), remove: vi.fn(async () => undefined) };
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
    createApplyCallbacks: () => ({ monitorGateway, packageGateway, cronGateway }),
    assertCurrent: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Gateway Claw Remove Apply", () => {
  it("uses the exact CLI plan under Gateway authority and strips private result fields", async () => {
    planClawRemoveForGateway.mockResolvedValue(preview);
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: canonical });
    runClawRemoveCli.mockResolvedValueOnce({
      code: 0,
      payload: { ...complete, privateToken: "never-return" },
    });

    const result = await applyClawRemoveForGateway(input());

    expect(result).toEqual({ agentId: "worker", status: "complete", agentRemoved: true });
    expect(planClawRemoveForGateway).toHaveBeenCalledWith({
      agentId: "worker",
      config: {},
      monitorGateway,
    });
    expect(runClawRemoveCli).toHaveBeenCalledTimes(2);
    expect(runClawRemoveCli.mock.calls[0]).toEqual([
      {
        agentId: "worker",
        signal: undefined,
        gatewayBridge: {
          previewOnly: true,
          agentId: "worker",
          assertCurrent: expect.any(Function),
          monitorGateway,
        },
      },
    ]);
    expect(runClawRemoveCli.mock.calls.at(1)?.[0]).toMatchObject({
      agentId: "worker",
      planIntegrity: canonical.planIntegrity,
      gatewayBridge: {
        agentId: "worker",
        assertCurrent: expect.any(Function),
        allowedCronJobIds: new Set(),
        createCallbacks: expect.any(Function),
      },
    });
  });

  it("grants cron callbacks only for live jobs in the reviewed removal", async () => {
    const withCron: ClawRemovePlan = {
      ...canonical,
      actions: [
        ...canonical.actions,
        {
          kind: "cronJob",
          id: "removed",
          action: "remove",
          target: "declaration-key",
          blocked: false,
          details: { expectedStatus: "removed" },
        },
        {
          kind: "cronJob",
          id: "live",
          action: "remove",
          target: "scheduler-daily",
          blocked: false,
          details: { expectedStatus: "complete", schedulerJobId: "scheduler-daily" },
        },
      ],
    };
    withCron.planIntegrity = digestClawRemovePlanIdentity(withCron);
    const projected = projectClawRemovePlan(withCron, {
      name: "@openclaw/workflow-operator",
      version: "1.0.0",
    });
    const review = structuredClone(projected);
    review.blockers = [];
    for (const action of review.actions) {
      action.blocked = false;
    }
    planClawRemoveForGateway.mockResolvedValue(review);
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: withCron });
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: complete });

    await applyClawRemoveForGateway(input({ planIntegrity: review.planIntegrity }));

    expect(runClawRemoveCli.mock.calls.at(1)?.[0].gatewayBridge.allowedCronJobIds).toEqual(
      new Set(["scheduler-daily"]),
    );
  });

  it("rejects a private cron target changed after the CLI plan was sealed", async () => {
    const job = {
      id: "daily",
      schedule: { cron: "0 8 * * *", timezone: "UTC" },
      session: "isolated",
      message: "Prepare a daily brief",
      delivery: { mode: "none" },
    };
    const withCron: ClawRemovePlan = {
      ...canonical,
      actions: [
        ...canonical.actions,
        {
          kind: "cronJob",
          id: "daily",
          action: "remove",
          target: "scheduler-owned",
          blocked: false,
          details: { expectedStatus: "complete", schedulerJobId: "scheduler-owned", job },
        },
      ],
    };
    withCron.planIntegrity = digestClawRemovePlanIdentity(withCron);
    const reviewed = projectClawRemovePlan(withCron, {
      name: "@openclaw/workflow-operator",
      version: "1.0.0",
    });
    expect(reviewed.blockers).toEqual([]);
    const forged = structuredClone(withCron);
    const forgedCron = forged.actions.find((action) => action.kind === "cronJob");
    if (!forgedCron) {
      throw new Error("Expected the reviewed cron action.");
    }
    forgedCron.target = "scheduler-unrelated";
    forgedCron.details!.schedulerJobId = "scheduler-unrelated";
    expect(
      projectClawRemovePlan(forged, {
        name: "@openclaw/workflow-operator",
        version: "1.0.0",
      }).planIntegrity,
    ).toBe(reviewed.planIntegrity);
    planClawRemoveForGateway.mockResolvedValue(reviewed);
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: forged });

    await expect(
      applyClawRemoveForGateway(input({ planIntegrity: reviewed.planIntegrity })),
    ).rejects.toBeInstanceOf(ClawGatewayPlanChangedError);
    expect(runClawRemoveCli).toHaveBeenCalledTimes(1);
  });

  it("does not report success when Gateway authority is revoked during Apply", async () => {
    let authorized = true;
    planClawRemoveForGateway.mockResolvedValue(preview);
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: canonical });
    runClawRemoveCli.mockImplementationOnce(async () => {
      authorized = false;
      return { code: 0, payload: complete };
    });
    expect(
      await applyClawRemoveForGateway(
        input({
          assertCurrent: () => {
            if (!authorized) {
              throw new Error("revoked");
            }
          },
        }),
      ),
    ).toMatchObject({
      status: "partial",
      error: { code: "remove_outcome_uncertain" },
    });
  });

  it("relays request cancellation to the mutating lifecycle", async () => {
    const controller = new AbortController();
    planClawRemoveForGateway.mockResolvedValue(preview);
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: canonical });
    runClawRemoveCli.mockImplementationOnce(async (params: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        params.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      params.signal.throwIfAborted();
    });

    const pending = applyClawRemoveForGateway(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(runClawRemoveCli).toHaveBeenCalledTimes(2));
    controller.abort();

    expect(await pending).toMatchObject({
      status: "partial",
      error: { code: "remove_outcome_uncertain" },
    });
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

  it("returns only a safe partial message for a partial or unknown lifecycle outcome", async () => {
    planClawRemoveForGateway.mockResolvedValue(preview);
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: canonical });
    runClawRemoveCli.mockResolvedValueOnce({
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

    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: canonical });
    runClawRemoveCli.mockRejectedValueOnce(new Error("token=secret"));
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
