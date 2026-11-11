import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import * as controllerMailbox from "../../sessions/session-controller.mailbox.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import type { TemplateContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  enqueueFollowupRun,
  reserveSteerCandidate,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

type SteeringReceiptFixture = {
  createMinimalRun: (params: {
    opts?: InternalGetReplyOptions;
    isActive?: boolean;
    shouldSteer?: boolean;
    shouldFollowup?: boolean;
    resolvedQueueMode?: string;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    sessionCtx?: Partial<TemplateContext>;
    runOverrides?: Partial<FollowupRun["run"]>;
    bindActiveAuthority?: boolean;
    attachSteerBackend?: boolean;
  }) => { followupRun: FollowupRun; run: () => Promise<unknown> };
  makeSessionEntry: (overrides?: Partial<SessionEntry>) => SessionEntry;
  makeSessionFixture: (
    overrides?: Partial<SessionEntry>,
    sessionKey?: string,
  ) => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
  }>;
  state: { backendQueueMessageMock: Mock; runEmbeddedAgentMock: Mock };
};

export function registerSteeringReceiptCases({
  createMinimalRun,
  makeSessionFixture,
  state,
}: SteeringReceiptFixture): void {
  it.each(
    [undefined, false].flatMap((allowCollaborativeSteering) =>
      [false, true].map((explicitCommand) => ({ allowCollaborativeSteering, explicitCommand })),
    ),
  )(
    "refuses another human's steer without leaving drainable work (collaboration: $allowCollaborativeSteering, explicit command: $explicitCommand)",
    async ({ allowCollaborativeSteering, explicitCommand }) => {
      const runState: ReplyOperationRunState = {};
      const onAdopted = vi.fn();
      const onAbandoned = vi.fn();
      const onSettled = vi.fn();
      const active = createReplyOperation({
        sessionKey: "main",
        sessionId: "session",
        resetTriggered: false,
      });
      const candidate = createMinimalRun({
        isActive: true,
        shouldSteer: true,
        resolvedQueueMode: "steer",
        bindActiveAuthority: false,
        sessionCtx: {
          Provider: "telegram",
          SenderId: "bob",
          ...(explicitCommand
            ? { CommandSource: "text" as const, CommandAuthorized: true, Body: "/steer stop" }
            : {}),
        },
        runOverrides: {
          messageProvider: "telegram",
          config: { messages: { queue: { allowCollaborativeSteering } } },
        },
        opts: {
          [REPLY_OPERATION_RUN_STATE]: runState,
          turnAdoptionLifecycle: { onAdopted, onAbandoned, onSettled },
        },
      });
      candidate.followupRun.run.config.messages!.queue!.collaborativeSteeringFallback = "reject";
      await active.bindToolAuthoritySnapshotAsync(
        prepareReplyToolAuthority({
          ...candidate.followupRun,
          run: { ...candidate.followupRun.run, senderId: "alice" },
        }),
      );
      active.setPhase("running");
      try {
        await candidate.run();
        expect(runState.admission).toEqual({
          status: "skipped",
          reason: "collaborative-steering-disabled",
        });
        expect(getExistingFollowupQueue("main")?.items ?? []).toEqual([]);
        expect(onAdopted).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
        expect(onAbandoned).not.toHaveBeenCalled();
        expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
        active.complete();
        expect(getExistingFollowupQueue("main")?.items ?? []).toEqual([]);
        expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      } finally {
        active.complete();
        clearSessionQueues(["main"]);
      }
    },
  );

  it("queues instead of steering when privilege facts differ on the active route", async ({
    signal,
  }) => {
    const actualQueue = await vi.importActual<typeof import("./queue.js")>("./queue.js");
    const followupTasks: Promise<void>[] = [];
    const observeFollowup =
      (runFollowup: Parameters<typeof scheduleFollowupDrain>[1]) => (queued: FollowupRun) => {
        const task = runFollowup(queued);
        followupTasks.push(task.catch(() => {}));
        return task;
      };
    vi.mocked(reserveSteerCandidate).mockImplementation((key, queued, settings, runFollowup) =>
      actualQueue.reserveSteerCandidate(key, queued, settings, observeFollowup(runFollowup)),
    );
    vi.mocked(scheduleFollowupDrain).mockImplementation((key, runFollowup) =>
      actualQueue.scheduleFollowupDrain(key, observeFollowup(runFollowup)),
    );
    const queued = createDeferred();
    const onDeferred = vi.fn(() => queued.resolve());
    const settled = createDeferred();
    const onAdopted = vi.fn();
    const onBlockReply = vi.fn();
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      runOverrides: { config: { messages: { queue: { allowCollaborativeSteering: false } } } },
      bindActiveAuthority: false,
      opts: {
        onBlockReply,
        turnAdoptionLifecycle: {
          onAdopted,
          onDeferred,
          onSettled: settled.resolve,
        },
      },
    });
    await active.bindToolAuthoritySnapshotAsync(
      prepareReplyToolAuthority({
        ...followupRun,
        run: {
          ...followupRun.run,
          runtimePluginToolGrant: {
            pluginId: "workboard",
            toolNames: ["workboard_complete"],
          },
        },
      }),
    );
    await active.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-fallback" });
    active.setPhase("running");
    try {
      await expect(run()).resolves.toBeUndefined();
      await withinTest(
        awaitGateBeforeSettlement(
          queued.promise,
          settled.promise,
          "followup settled before queue acceptance",
        ),
        signal,
      );
      expect(onDeferred).toHaveBeenCalledOnce();
      expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(onAdopted).not.toHaveBeenCalled();
      expect(onBlockReply).not.toHaveBeenCalled();

      active.complete();
      await withinTest(settled.promise, signal);
      await Promise.all(followupTasks);
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
        prompt: "hello",
      });
      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "final" }));
    } finally {
      active.complete();
      clearSessionQueues(["main"], getSessionControllerEntryForOperation(active).target);
      await Promise.all(followupTasks);
    }
  });

  it("does not steer, enqueue, or start a second run after accepted Gateway injection", async () => {
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: {
        messageInjectionDisposition: "accepted",
        [REPLY_OPERATION_RUN_STATE]: runState,
      },
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });

    await expect(run()).resolves.toBeUndefined();

    expect(runState.admission).toEqual({ status: "accepted", mode: "steer" });
    expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each(["new", "old"] as const)(
    "keeps a rejected steer skipped when drop:%s discards it",
    async (dropPolicy) => {
      using warning = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
      const actualQueue = await vi.importActual<typeof import("./queue.js")>("./queue.js");
      vi.mocked(reserveSteerCandidate).mockImplementation(actualQueue.reserveSteerCandidate);
      const active = createReplyOperation({
        sessionKey: "main",
        sessionId: "session",
        resetTriggered: false,
      });
      active.setPhase("running");
      const replyState: ReplyOperationRunState = {
        admission: { status: "skipped", reason: "active-run" },
      };
      const candidate = createMinimalRun({
        isActive: true,
        shouldSteer: true,
        shouldFollowup: true,
        resolvedQueueMode: "steer",
        sessionCtx: { MessageSid: `rejected-steer-${dropPolicy}` },
        opts: { [REPLY_OPERATION_RUN_STATE]: replyState },
      });
      candidate.followupRun.messageId = `rejected-steer-${dropPolicy}`;
      const retained: FollowupRun = {
        ...candidate.followupRun,
        messageId: `retained-followup-${dropPolicy}`,
      };
      const enqueueRetained = () =>
        actualQueue.enqueueFollowupRun(
          "main",
          retained,
          { mode: "steer", cap: 1, dropPolicy, debounceMs: 0 },
          "message-id",
          undefined,
          false,
        );
      if (dropPolicy === "new") {
        enqueueRetained();
      } else {
        state.backendQueueMessageMock.mockImplementationOnce(() => {
          enqueueRetained();
          return false;
        });
      }
      try {
        await candidate.run();
        expect(warning).toHaveBeenCalledWith(
          "steering rejected; applying follow-up policy",
          expect.objectContaining({ reason: "runtime_rejected", disposition: "skipped-queue-cap" }),
        );
        expect(state.backendQueueMessageMock).toHaveBeenCalledOnce();
        expect(replyState.admission).toEqual({ status: "skipped", reason: "queue-cap" });
        expect(getExistingFollowupQueue("main")?.items).toEqual([retained]);
      } finally {
        clearSessionQueues(["main"], getSessionControllerEntryForOperation(active).target);
        active.complete();
      }
    },
  );

  it("queues a waiting steer after its backend becomes unavailable", async ({ signal }) => {
    const actualQueue = await vi.importActual<typeof import("./queue.js")>("./queue.js");
    vi.mocked(reserveSteerCandidate).mockImplementation(actualQueue.reserveSteerCandidate);
    const sessionKey = "agent:main:main";
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture(
      { status: undefined },
      sessionKey,
    );
    const active = createReplyOperation({
      sessionKey,
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    const firstEntered = createDeferred();
    const firstAcceptance = createDeferred<boolean>();
    const secondParked = createDeferred();
    const onDeferred = vi.fn();
    const inject = controllerMailbox.beginSessionControllerSourceInjection;
    const injection = vi
      .spyOn(controllerMailbox, "beginSessionControllerSourceInjection")
      .mockImplementation((input, options) => {
        const receipt = inject(input, options);
        if (input.source?.messageId === "second-parked-input") {
          expect(input.phase).toBe("injecting");
          secondParked.resolve();
        }
        return receipt;
      });
    state.backendQueueMessageMock.mockReturnValue(true);
    state.backendQueueMessageMock.mockImplementationOnce(() => {
      firstEntered.resolve();
      return firstAcceptance.promise;
    });
    const common = {
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
      sessionEntry,
      sessionStore,
      storePath,
      sessionKey,
      runOverrides: { agentId: "main" },
    };
    const first = createMinimalRun({
      ...common,
      sessionCtx: { MessageSid: "first-parked-input" },
    });
    first.followupRun.messageId = "first-parked-input";
    const secondState: ReplyOperationRunState = {
      admission: { status: "skipped", reason: "active-run" },
    };
    const senderId = "bob";
    const second = createMinimalRun({
      ...common,
      bindActiveAuthority: false,
      attachSteerBackend: false,
      sessionCtx: { MessageSid: "second-parked-input", SenderId: senderId },
      opts: {
        [REPLY_OPERATION_RUN_STATE]: secondState,
        turnAdoptionLifecycle: {
          onDeferred,
          onAdopted: async () => {},
        },
      },
    });
    second.followupRun.messageId = "second-parked-input";
    second.followupRun.prompt = "answer the second input";
    const firstRun = first.run();
    let secondRun: Promise<unknown> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          firstEntered.promise,
          firstRun,
          "first steer settled before reaching its backend",
        ),
        signal,
      );
      secondRun = second.run();
      await withinTest(
        awaitGateBeforeSettlement(
          secondParked.promise,
          secondRun,
          "second steer settled before parking",
        ),
        signal,
      );
      const backend = expectDefined(
        getSessionControllerEntryForOperation(active).attachment?.backend?.handle
          .messageInjectionV2,
        "The first steer installed its guarded backend",
      );
      using availability = vi.spyOn(backend, "isAvailable").mockReturnValue(false);

      firstAcceptance.resolve(true);
      await Promise.all([firstRun, secondRun]);

      expect(availability).toHaveBeenCalled();
      expect(state.backendQueueMessageMock).toHaveBeenCalledOnce();
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(secondState.admission).toEqual({
        status: "accepted",
        mode: "followup",
        reason: "steering-unavailable",
      });
      expect(onDeferred).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(sessionKey)?.items).toEqual([
        expect.objectContaining({
          messageId: "second-parked-input",
          prompt: "answer the second input",
          run: expect.objectContaining({ senderId }),
        }),
      ]);
    } finally {
      firstAcceptance.resolve(true);
      await Promise.allSettled([firstRun, ...(secondRun ? [secondRun] : [])]);
      clearSessionQueues([sessionKey], getSessionControllerEntryForOperation(active).target);
      active.complete();
      injection.mockRestore();
    }
  });
}
