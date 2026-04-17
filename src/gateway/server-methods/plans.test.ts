import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanRecord, resetPlanRegistryForTests } from "../../plans/plan-registry.js";
import { ErrorCodes } from "../protocol/index.js";

const hoisted = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  resolveGatewaySessionStoreTargetMock: vi.fn(),
  migrateAndPruneGatewaySessionStoreKeyMock: vi.fn(),
  applySessionsPatchToStoreMock: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => hoisted.loadConfigMock(),
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: (...args: unknown[]) => hoisted.updateSessionStoreMock(...args),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionStoreTarget: (...args: unknown[]) =>
      hoisted.resolveGatewaySessionStoreTargetMock(...args),
    migrateAndPruneGatewaySessionStoreKey: (...args: unknown[]) =>
      hoisted.migrateAndPruneGatewaySessionStoreKeyMock(...args),
  };
});

vi.mock("../sessions-patch.js", async () => {
  const actual =
    await vi.importActual<typeof import("../sessions-patch.js")>("../sessions-patch.js");
  return {
    ...actual,
    applySessionsPatchToStore: (...args: unknown[]) =>
      hoisted.applySessionsPatchToStoreMock(...args),
  };
});

import { plansHandlers } from "./plans.js";

function findPlanIdByTitleFromRespond(
  call: RespondCall | undefined,
  title: string,
): string | undefined {
  return (
    (call?.[1] as { plans?: Array<{ planId: string; title: string }> } | undefined)?.plans ?? []
  ).find((plan) => plan.title === title)?.planId;
}

function findPlanByTitleFromRespond(
  call: RespondCall | undefined,
  title: string,
):
  | {
      planId: string;
      status: string;
      updatedAt?: number;
      reviewedAt?: number;
      approvedAt?: number;
      rejectedAt?: number;
    }
  | undefined {
  return (
    (
      call?.[1] as
        | {
            plans?: Array<{
              planId: string;
              title: string;
              status: string;
              updatedAt?: number;
              reviewedAt?: number;
              approvedAt?: number;
              rejectedAt?: number;
            }>;
          }
        | undefined
    )?.plans ?? []
  ).find((plan) => plan.title === title);
}

function listPlansCall() {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await plansHandlers["plans.list"]({
        params: {},
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-list", method: "plans.list" },
        isWebchatConnect: () => false,
      }),
  };
}

function createSessionStoreRow(): Record<string, unknown> {
  return {
    updatedAt: 1,
    planMode: "active",
    planArtifact: {
      status: "active",
      goal: "Ship phase 3",
      enteredAt: 1,
      updatedAt: 1,
    },
  };
}

function setupSessionPersistenceMocks() {
  let currentEntry: Record<string, unknown> = createSessionStoreRow();
  hoisted.loadConfigMock.mockReturnValue({});
  hoisted.resolveGatewaySessionStoreTargetMock.mockReturnValue({
    canonicalKey: "agent:main:main",
    storePath: "/tmp/sessions.json",
    storeKeys: ["agent:main:main"],
    agentId: "main",
  });
  hoisted.migrateAndPruneGatewaySessionStoreKeyMock.mockReturnValue({
    primaryKey: "agent:main:main",
  });
  hoisted.updateSessionStoreMock.mockImplementation(
    async (
      _storePath: string,
      mutator: (store: Record<string, Record<string, unknown>>) => unknown,
    ) => await mutator({ "agent:main:main": currentEntry }),
  );
  hoisted.applySessionsPatchToStoreMock.mockImplementation(
    async ({ patch }: { patch: Record<string, unknown> }) => {
      currentEntry = {
        ...currentEntry,
        ...(patch.planArtifact
          ? {
              planArtifact: {
                ...(currentEntry.planArtifact as Record<string, unknown>),
                ...(patch.planArtifact as Record<string, unknown>),
              },
            }
          : {}),
      };
      return {
        ok: true,
        entry: currentEntry,
      };
    },
  );
  return {
    getCurrentEntry: () => currentEntry,
  };
}

function setupNoopSessionPersistenceMocks() {
  hoisted.loadConfigMock.mockReset();
  hoisted.updateSessionStoreMock.mockReset();
  hoisted.resolveGatewaySessionStoreTargetMock.mockReset();
  hoisted.migrateAndPruneGatewaySessionStoreKeyMock.mockReset();
  hoisted.applySessionsPatchToStoreMock.mockReset();
}

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(method: keyof typeof plansHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await plansHandlers[method]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

describe("plans gateway handlers", () => {
  beforeEach(() => {
    setupNoopSessionPersistenceMocks();
    resetPlanRegistryForTests();
    createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sessionKey: "session-1",
      title: "Week 1 orchestration metadata",
      summary: "Add inspect-only plan surfaces.",
      content: "- tools.catalog metadata\n- plans inspect",
      status: "ready_for_review",
      linkedFlowIds: ["flow-1"],
      createdAt: 100,
      updatedAt: 200,
    });
    createPlanRecord({
      ownerKey: "agent:work:main",
      scopeKind: "agent",
      title: "Deferred lifecycle work",
      content: "- status transitions later",
      status: "draft",
      createdAt: 300,
      updatedAt: 300,
    });
  });

  it("rejects invalid plans.list params", async () => {
    const { respond, invoke } = createInvokeParams("plans.list", { extra: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid plans.list params");
  });

  it("lists plans with filters and summary", async () => {
    const { respond, invoke } = createInvokeParams("plans.list", {
      ownerKey: "agent:main:main",
      status: "ready_for_review",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as
      | {
          count: number;
          summary: { total: number; byStatus: Record<string, number> };
          plans: Array<{ title: string; ownerKey: string; status: string }>;
        }
      | undefined;
    expect(payload?.count).toBe(1);
    expect(payload?.summary.total).toBe(1);
    expect(payload?.summary.byStatus.ready_for_review).toBe(1);
    expect(payload?.plans[0]).toMatchObject({
      title: "Week 1 orchestration metadata",
      ownerKey: "agent:main:main",
      status: "ready_for_review",
    });
  });

  it("rejects invalid plans.get params", async () => {
    const { respond, invoke } = createInvokeParams("plans.get", {});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid plans.get params");
  });

  it("returns one plan by id", async () => {
    const list = createInvokeParams("plans.list", {});
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const firstPlanId = ((listCall?.[1] as { plans?: Array<{ planId: string }> } | undefined)
      ?.plans ?? [])[0]?.planId;

    const { respond, invoke } = createInvokeParams("plans.get", { planId: firstPlanId });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as { plan: { planId: string; title: string; status: string } };
    expect(payload.plan).toMatchObject({
      planId: firstPlanId,
      title: "Deferred lifecycle work",
      status: "draft",
    });
  });

  it("updates one plan status when the transition is valid", async () => {
    const list = createInvokeParams("plans.list", {});
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const draftPlan = findPlanByTitleFromRespond(listCall, "Deferred lifecycle work");

    const { respond, invoke } = createInvokeParams("plans.updateStatus", {
      planId: draftPlan?.planId,
      status: "ready_for_review",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as { previousStatus: string; plan: { status: string } };
    expect(payload.previousStatus).toBe("draft");
    expect(payload.plan.status).toBe("ready_for_review");
  });

  it("persists compatible session plan artifact updates", async () => {
    const persisted = setupSessionPersistenceMocks();
    createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sessionKey: "agent:main:main",
      title: "Session approval plan",
      content: "- complete final review",
      status: "ready_for_review",
      createdAt: 400,
      updatedAt: 400,
    });

    const list = listPlansCall();
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const sessionPlanId = findPlanIdByTitleFromRespond(listCall, "Session approval plan");

    const { respond, invoke } = createInvokeParams("plans.updateStatus", {
      planId: sessionPlanId,
      status: "approved",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledWith(
      "/tmp/sessions.json",
      expect.any(Function),
    );
    expect(hoisted.applySessionsPatchToStoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeKey: "agent:main:main",
        patch: expect.objectContaining({
          key: "agent:main:main",
          planArtifact: expect.objectContaining({
            status: "completed",
          }),
        }),
      }),
    );
    expect(
      (persisted.getCurrentEntry().planArtifact as { status?: string; approvedAt?: number }).status,
    ).toBe("completed");
    expect(
      typeof (persisted.getCurrentEntry().planArtifact as { approvedAt?: number }).approvedAt,
    ).toBe("number");
  });

  it("returns an error when session plan artifact persistence fails", async () => {
    setupSessionPersistenceMocks();
    hoisted.applySessionsPatchToStoreMock.mockResolvedValue({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message: "session artifact persist failed" },
    });
    createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sessionKey: "agent:main:main",
      title: "Session rejected plan",
      content: "- decline changes",
      status: "ready_for_review",
      createdAt: 500,
      updatedAt: 500,
    });

    const list = listPlansCall();
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const sessionPlanId = findPlanIdByTitleFromRespond(listCall, "Session rejected plan");

    const { respond, invoke } = createInvokeParams("plans.updateStatus", {
      planId: sessionPlanId,
      status: "rejected",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("session artifact persist failed");

    const failedList = listPlansCall();
    await failedList.invoke();
    const failedListCall = failedList.respond.mock.calls[0] as RespondCall | undefined;
    const failedPlan = findPlanByTitleFromRespond(failedListCall, "Session rejected plan");
    expect(failedPlan?.status).toBe("ready_for_review");
    expect(failedPlan?.updatedAt).toBe(500);
    expect(failedPlan?.reviewedAt).toBeUndefined();
    expect(failedPlan?.rejectedAt).toBeUndefined();
  });

  it("allows retry after session plan artifact persistence fails once", async () => {
    setupSessionPersistenceMocks();
    let persistAttempts = 0;
    hoisted.applySessionsPatchToStoreMock.mockImplementation(
      async ({ patch }: { patch: Record<string, unknown> }) => {
        persistAttempts += 1;
        if (persistAttempts === 1) {
          return {
            ok: false,
            error: { code: ErrorCodes.INVALID_REQUEST, message: "session artifact persist failed" },
          };
        }
        return {
          ok: true,
          entry: {
            updatedAt: 1,
            planMode: "active",
            planArtifact: patch.planArtifact,
          },
        };
      },
    );
    createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sessionKey: "agent:main:main",
      title: "Session retry plan",
      content: "- retry after failure",
      status: "ready_for_review",
      createdAt: 600,
      updatedAt: 600,
    });

    const initialList = listPlansCall();
    await initialList.invoke();
    const initialCall = initialList.respond.mock.calls[0] as RespondCall | undefined;
    const sessionPlanId = findPlanIdByTitleFromRespond(initialCall, "Session retry plan");

    const firstAttempt = createInvokeParams("plans.updateStatus", {
      planId: sessionPlanId,
      status: "approved",
    });
    await firstAttempt.invoke();
    const firstCall = firstAttempt.respond.mock.calls[0] as RespondCall | undefined;
    expect(firstCall?.[0]).toBe(false);
    expect(firstCall?.[2]?.message).toContain("session artifact persist failed");

    const failedList = listPlansCall();
    await failedList.invoke();
    const failedListCall = failedList.respond.mock.calls[0] as RespondCall | undefined;
    const failedPlan = findPlanByTitleFromRespond(failedListCall, "Session retry plan");
    expect(failedPlan?.status).toBe("ready_for_review");
    expect(failedPlan?.updatedAt).toBe(600);
    expect(failedPlan?.reviewedAt).toBeUndefined();
    expect(failedPlan?.approvedAt).toBeUndefined();

    const secondAttempt = createInvokeParams("plans.updateStatus", {
      planId: sessionPlanId,
      status: "approved",
    });
    await secondAttempt.invoke();
    const secondCall = secondAttempt.respond.mock.calls[0] as RespondCall | undefined;
    expect(secondCall?.[0]).toBe(true);
    const payload = secondCall?.[1] as { previousStatus: string; plan: { status: string } };
    expect(payload.previousStatus).toBe("ready_for_review");
    expect(payload.plan.status).toBe("approved");
  });

  it("does not persist session artifacts for non-session plans", async () => {
    setupSessionPersistenceMocks();
    const list = listPlansCall();
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const draftPlan = findPlanByTitleFromRespond(listCall, "Deferred lifecycle work");

    const { respond, invoke } = createInvokeParams("plans.updateStatus", {
      planId: draftPlan?.planId,
      status: "ready_for_review",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
    expect(hoisted.applySessionsPatchToStoreMock).not.toHaveBeenCalled();
  });

  it("rejects invalid plan status transitions", async () => {
    const list = createInvokeParams("plans.list", {});
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const draftPlanId = (
      (listCall?.[1] as { plans?: Array<{ planId: string; status: string }> } | undefined)?.plans ??
      []
    ).find((plan) => plan.status === "draft")?.planId;

    const { respond, invoke } = createInvokeParams("plans.updateStatus", {
      planId: draftPlanId,
      status: "approved",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid plan status transition draft -> approved");
  });

  it("rejects unknown plan ids", async () => {
    const { respond, invoke } = createInvokeParams("plans.get", { planId: "plan_missing" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown plan id "plan_missing"');
  });
});
