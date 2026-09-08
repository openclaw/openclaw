import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  deleteTaskFlowRecordById,
  getTaskFlowById,
  listTaskFlowsForOwnerKey,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-registry.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import {
  consumeStagedPostCompactionDelegates,
  finalizeStagedPostCompactionDelegates,
  requeueReleasedPostCompactionDelegate,
  stagePostCompactionDelegate,
} from "../continuation/delegate-store-post-compaction.js";
import type { ContinuationRuntimeConfig } from "../continuation/types.js";
import {
  dispatchPostCompactionDelegates,
  type PostCompactionDelegateDispatchDeps,
} from "./post-compaction-delegate-dispatch.js";
import type { FollowupRun } from "./queue/types.js";

const cfg: OpenClawConfig = {};
const runtimeConfig: ContinuationRuntimeConfig = {
  enabled: true,
  defaultDelayMs: 0,
  minDelayMs: 0,
  maxDelayMs: 1_000,
  maxChainLength: 4,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
  maxPendingWork: 32,
  crossSessionTargeting: "disabled",
};

function delegate(
  task: string,
  returnOptions?: SessionPostCompactionDelegate["returnOptions"],
): SessionPostCompactionDelegate {
  return {
    task,
    createdAt: 1,
    ...(returnOptions ? { returnOptions } : {}),
  };
}

function followupRun(abortSignal?: AbortSignal): FollowupRun {
  return {
    prompt: "hello",
    enqueuedAt: 1,
    ...(abortSignal ? { abortSignal } : {}),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: cfg,
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

function configureInMemoryTaskFlows(): void {
  resetTaskFlowRegistryForTests({ persist: false });
  configureTaskFlowRegistryRuntime({
    store: {
      loadSnapshot: () => ({ flows: new Map() }),
      upsertFlow: () => {},
      deleteFlow: () => {},
    },
  });
}

function createOwnerDeps(params?: {
  abortDuringContext?: AbortController;
}): PostCompactionDelegateDispatchDeps {
  return {
    consumeStagedPostCompactionDelegates,
    finalizeStagedPostCompactionDelegates,
    requeueReleasedPostCompactionDelegate,
    stagePostCompactionDelegate,
    drainPostCompactionDelegateDeliveries: vi.fn(async () => undefined),
    enqueuePostCompactionDelegateDelivery: vi.fn(async ({ sequence }) => `queue-${sequence}`),
    enqueueSystemEvent: vi.fn(),
    log: vi.fn(),
    now: vi.fn(() => 1),
    readPostCompactionContext: vi.fn(async () => {
      params?.abortDuringContext?.abort("originating turn cancelled");
      return null;
    }),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
    resolveContinuationRuntimeConfig: vi.fn(() => runtimeConfig),
    resolveSessionAgentId: vi.fn(() => "main"),
  };
}

afterEach(() => {
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("post-compaction delegate cancellation ownership", () => {
  it.each([
    { name: "non-artifact", returnOptions: undefined },
    { name: "artifact", returnOptions: { artifacts: "required" as const } },
  ])(
    "keeps a $name delegate exclusively TaskFlow-owned after a revision advance",
    async ({ returnOptions }) => {
      configureInMemoryTaskFlows();
      const sessionKey = "agent:main:revision-advance";
      const flowId = expectDefined(
        stagePostCompactionDelegate(
          sessionKey,
          delegate("keep the advanced TaskFlow authoritative", returnOptions),
        ),
        "staged TaskFlow",
      ).flowId;
      const abort = new AbortController();
      const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
      const deps = createOwnerDeps({ abortDuringContext: abort });
      deps.requeueReleasedPostCompactionDelegate = (claimed) => {
        const advanced = updateFlowRecordByIdExpectedRevision({
          flowId: expectDefined(claimed.flowId, "claimed flow id"),
          expectedRevision: expectDefined(claimed.expectedRevision, "claimed revision"),
          patch: { currentStep: "Concurrent owner advanced the flow" },
        });
        expect(advanced.applied).toBe(true);
        return requeueReleasedPostCompactionDelegate(claimed);
      };
      const exactFinalize = vi.spyOn(deps, "finalizeStagedPostCompactionDelegates");

      await expect(
        dispatchPostCompactionDelegates(
          {
            cfg,
            compactionCount: 1,
            followupRun: followupRun(abort.signal),
            postCompactionDelegatesToPreserve: [],
            sessionEntry,
            sessionKey,
          },
          deps,
        ),
      ).resolves.toEqual({ queuedDelegates: 0, droppedDelegates: 0 });

      expect(sessionEntry.pendingPostCompactionDelegates).toBeUndefined();
      expect(exactFinalize).toHaveBeenCalledWith([]);
      expect(listTaskFlowsForOwnerKey(sessionKey)).toEqual([
        expect.objectContaining({
          flowId,
          status: "running",
          revision: 2,
          currentStep: "Concurrent owner advanced the flow",
        }),
      ]);

      const retryDeps = createOwnerDeps();
      const retryEnqueue = vi.fn(async () => "queue");
      retryDeps.enqueuePostCompactionDelegateDelivery = retryEnqueue;
      await expect(
        dispatchPostCompactionDelegates(
          {
            cfg,
            compactionCount: 2,
            followupRun: followupRun(),
            postCompactionDelegatesToPreserve: [],
            sessionEntry,
            sessionKey,
          },
          retryDeps,
        ),
      ).resolves.toEqual({ queuedDelegates: 0, droppedDelegates: 0 });
      expect(retryEnqueue).not.toHaveBeenCalled();
      expect(getTaskFlowById(flowId)).toMatchObject({
        status: "running",
        revision: 2,
        currentStep: "Concurrent owner advanced the flow",
      });
    },
  );

  it("cannot leave a pending duplicate when finalization throws after a revision advance", async () => {
    configureInMemoryTaskFlows();
    const sessionKey = "agent:main:revision-advance-finalize-error";
    const flowId = expectDefined(
      stagePostCompactionDelegate(
        sessionKey,
        delegate("keep one owner across finalization failure"),
      ),
      "staged TaskFlow",
    ).flowId;
    const abort = new AbortController();
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const deps = createOwnerDeps({ abortDuringContext: abort });
    deps.requeueReleasedPostCompactionDelegate = (claimed) => {
      const advanced = updateFlowRecordByIdExpectedRevision({
        flowId: expectDefined(claimed.flowId, "claimed flow id"),
        expectedRevision: expectDefined(claimed.expectedRevision, "claimed revision"),
        patch: { currentStep: "Concurrent owner advanced before finalization" },
      });
      expect(advanced.applied).toBe(true);
      return requeueReleasedPostCompactionDelegate(claimed);
    };
    deps.finalizeStagedPostCompactionDelegates = vi.fn(() => {
      throw new Error("finalization failed");
    });

    await expect(
      dispatchPostCompactionDelegates(
        {
          cfg,
          compactionCount: 1,
          followupRun: followupRun(abort.signal),
          postCompactionDelegatesToPreserve: [],
          sessionEntry,
          sessionKey,
        },
        deps,
      ),
    ).rejects.toThrow("finalization failed");

    expect(sessionEntry.pendingPostCompactionDelegates).toBeUndefined();
    expect(getTaskFlowById(flowId)).toMatchObject({
      status: "running",
      revision: 2,
      currentStep: "Concurrent owner advanced before finalization",
    });
  });

  it.each([
    { name: "non-artifact", returnOptions: undefined },
    { name: "artifact", returnOptions: { artifacts: "required" as const } },
  ])(
    "preserves a $name delegate when its TaskFlow row is truly missing",
    async ({ returnOptions }) => {
      configureInMemoryTaskFlows();
      const sessionKey = "agent:main:missing-source";
      const source = delegate("preserve work after source loss", returnOptions);
      const flowId = expectDefined(
        stagePostCompactionDelegate(sessionKey, source),
        "staged TaskFlow",
      ).flowId;
      const abort = new AbortController();
      const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
      const deps = createOwnerDeps({ abortDuringContext: abort });
      deps.requeueReleasedPostCompactionDelegate = (claimed) => {
        expect(deleteTaskFlowRecordById(expectDefined(claimed.flowId, "claimed flow id"))).toBe(
          true,
        );
        return requeueReleasedPostCompactionDelegate(claimed);
      };

      await expect(
        dispatchPostCompactionDelegates(
          {
            cfg,
            compactionCount: 1,
            followupRun: followupRun(abort.signal),
            postCompactionDelegatesToPreserve: [],
            sessionEntry,
            sessionKey,
          },
          deps,
        ),
      ).resolves.toEqual({ queuedDelegates: 0, droppedDelegates: 0 });

      expect(getTaskFlowById(flowId)).toBeUndefined();
      expect(sessionEntry.pendingPostCompactionDelegates).toEqual([
        expect.objectContaining({
          task: source.task,
          ...(returnOptions ? { returnOptions } : {}),
          recipientAuthorityBinding: expect.objectContaining({
            recipients: [
              expect.objectContaining({
                sessionKey,
                authority: expect.objectContaining({ state: "bound" }),
              }),
            ],
          }),
        }),
      ]);
      expect(sessionEntry.pendingPostCompactionDelegates?.[0]).not.toHaveProperty("flowId");
      expect(sessionEntry.pendingPostCompactionDelegates?.[0]).not.toHaveProperty(
        "expectedRevision",
      );
    },
  );
});
