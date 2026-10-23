import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as harnessRecovery from "../../agents/agent-harness-completion-recovery.js";
import { renderAssistantRequestFailureCopy } from "../../agents/failover/assistant-request-failure-copy.js";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type { HarnessCompletionRecovery } from "../../config/sessions/restart-recovery-types.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionActors from "../../config/sessions/session-actor.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { resolveDeliveryQueueStateEnv } from "../delivery-queue-state-context.js";
import { classifyGatewayStorageFailure } from "../sqlite-error-diagnostics.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import * as workerAdmission from "../sqlite-worker-operation-admission.js";
import { settleDurableDelivery, settlePendingFinalDelivery } from "./delivery-completion.js";
import { createPendingFinalFixture } from "./delivery-queue.test-helpers.js";

const recoveryMocks = vi.hoisted(() => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock(
  "../../agents/main-session-recovery/main-session-recovery-owner-release.js",
  () => recoveryMocks,
);
// mock-isolation: Fixture seed writes must not schedule retention requests into this census.
vi.mock("../../config/sessions/session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
const wake = recoveryMocks.scheduleMainSessionRecoveryPendingTarget;
type Settlement = Parameters<typeof settlePendingFinalDelivery>;
type PendingUpdate = Partial<
  Pick<
    NonNullable<InternalSessionEntry["pendingFinalDelivery"]>,
    "context" | "deliveries" | "intentId"
  >
>;

function observeActorCommands(
  hooks: { beforeCommand?: () => void; beforeCommit?: () => void } = {},
) {
  const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const commands: string[] = [];
  vi.spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
    (...args) => {
      const owner = capture(...args);
      const runExisting = owner.runExisting.bind(owner);
      owner.runExisting = (source, run, options) =>
        runExisting(
          source,
          (worker) =>
            run({
              execute: (command, commandOptions) => {
                commands.push(command.type);
                if (command.type === "session.actor.deliverySettled") {
                  hooks.beforeCommand?.();
                }
                return worker.execute(command, commandOptions);
              },
            }),
          options,
        );
      return owner;
    },
  );
  vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (authorize, attachment) =>
      createAdmission((request, grant) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          isRecord(request.facts.publication) &&
          request.facts.publication.kind === "session-actor-admission" &&
          request.facts.publication.final === true
        ) {
          hooks.beforeCommit?.();
        }
        return authorize(request, grant);
      }, attachment),
  );
  return commands;
}

describe("pending-final delivery completion", () => {
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:main";
  const { completion, entry: seed } = createPendingFinalFixture("", "delivery-1", sessionKey);
  const { sessionId, intentId, deliveryId } = completion;

  const sessionScope = () => ({ sessionKey, storePath });
  const read = (target = sessionScope()) => loadSessionEntry(target);
  const writeSync = (entry: InternalSessionEntry) => replaceSessionEntrySync(sessionScope(), entry);
  const settle = (
    state: Settlement[1],
    from?: Settlement[2],
    options?: Settlement[3],
    target = completion,
  ) => settlePendingFinalDelivery(target, state, from, options);
  const deliveries = (state: Settlement[1]) => [{ id: deliveryId, state }];
  const check = (
    state: Settlement[1],
    result: Settlement[1] | "stale" = state,
    from?: Settlement[2],
    options?: Settlement[3],
    target = completion,
  ) => expect(settle(state, from, options, target)).resolves.toEqual({ state: result });

  async function updatePending(
    pending: PendingUpdate,
    fields: Partial<InternalSessionEntry> = {},
    scope = { sessionKey, storePath },
  ) {
    const entry = read()!;
    await replaceSessionEntry(scope, {
      ...entry,
      ...fields,
      pendingFinalDelivery: { ...entry.pendingFinalDelivery!, ...pending },
    });
  }

  function expectPendingWithoutNotice(state: Parameters<typeof deliveries>[0]) {
    const entry = read();
    expect(entry?.pendingDeliveryNotice).toBeUndefined();
    expect(entry?.pendingFinalDelivery).toMatchObject({ deliveries: deliveries(state) });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-delivery-completion-"));
    storePath = path.join(tmpDir, "sessions.json");
    completion.storePath = storePath;
    await replaceSessionEntry(sessionScope(), {
      ...seed,
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 1 },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves storage guidance when final delivery settlement has an unknown outcome", async () => {
    const before = read();
    const createActor = sessionActors.createSessionActor;
    vi.spyOn(sessionActors, "createSessionActor").mockImplementation((params) => {
      const actor = createActor(params);
      vi.spyOn(actor, "deliverySettled").mockResolvedValue({
        kind: "unknown",
        target: actor.target,
        commandId: "storage-failure",
        error: {
          name: "Error",
          message: "Unconfirmed actor settlement",
          cause: Object.assign(new Error("database or disk is full"), { errcode: 13 }),
        },
      });
      return actor;
    });
    await expect(settle("delivered", ["prepared"])).rejects.toSatisfy((error: unknown) => {
      expect(
        renderAssistantRequestFailureCopy({ storageFailure: classifyGatewayStorageFailure(error) }),
      ).toContain("disk is full. Free up space");
      return hasSqliteWorkerOutcomeUnknown(error);
    });
    expect(read()).toEqual(before);
    expect(wake).not.toHaveBeenCalled();
  });

  it("invalidates an earlier recovery decision and wakes the exact session", async () => {
    const observation = { sessionId, cycleId: "cycle-1", revision: 1 };

    const sql = observeHostDataSql();
    try {
      await check("delivered");
      const hostWrite = /session_nodes|session_entry_snapshots|\b(?:BEGIN|COMMIT|ROLLBACK)\b/i;
      expect(sql.queries.filter((query) => hostWrite.test(query))).toEqual([]);
    } finally {
      sql.restore();
    }

    expect(read()).toMatchObject({
      mainRestartRecovery: { revision: 2 },
      pendingFinalDelivery: { deliveries: deliveries("delivered") },
    });
    expect(wake).toHaveBeenCalledWith({ sessionId, ...sessionScope() });
    wake.mockClear();
    const completed = read();
    await check("delivered");
    expect(read()).toEqual(completed);
    expect(wake).not.toHaveBeenCalled();
    await expect(
      commitMainSessionRecovery({
        command: {
          kind: "tombstone",
          now: Date.now(),
          observation,
          reason: "stale delivery decision",
        },
        requireWriteSuccess: true,
        target: sessionScope(),
      }),
    ).resolves.toMatchObject({ transition: { kind: "rejected", reason: "stale_revision" } });
  });

  it("settles incognito custody on its retained memory owner", async () => {
    const incognitoKey = "agent:main:dashboard:incognito-delivery";
    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const nativePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    const scope = { sessionKey: incognitoKey, storePath: nativePath, env };
    const nativeCompletion = { ...completion, sessionKey: incognitoKey, storePath: nativePath };
    try {
      await replaceSessionEntry(scope, { ...seed, incognito: true });
      for (const [state, from, result] of [
        ["queued", "prepared", "queued"],
        ["delivered", "queued", "delivered"],
        ["queued", "prepared", "stale"],
      ] as const) {
        await check(state, result, [from], { stateDir: tmpDir }, nativeCompletion);
        expect(read(scope)?.pendingFinalDelivery?.deliveries).toEqual(
          deliveries(result === "stale" ? "delivered" : result),
        );
      }
      await expect(fs.stat(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await disposeOpenClawAgentDatabaseByPath(nativePath);
    }
  });

  it("rolls back settled delivery and cleanup together without losing an intervening write", async () => {
    const initial = read()!;
    const preserved = { label: "committed while delivery settled", updatedAt: initial.updatedAt };
    const crash = "synthetic crash before delivery cleanup commit";
    let failCommit = true;
    observeActorCommands({
      beforeCommand: vi.fn().mockImplementationOnce(() => writeSync({ ...initial, ...preserved })),
      beforeCommit() {
        if (failCommit) {
          throw new Error(crash);
        }
      },
    });
    const options = { preserveActivity: true, clearAfterSettled: {} };
    await expect(settle("delivered", ["prepared"], options)).rejects.toThrow(crash);
    expect(read()).toMatchObject({
      ...preserved,
      pendingFinalDelivery: initial.pendingFinalDelivery,
    });
    expect(wake).not.toHaveBeenCalled();

    failCommit = false;
    await check("delivered", undefined, ["prepared"], options);
    const settled = read();
    expect(settled?.pendingFinalDelivery).toBeUndefined();
    expect(settled).toMatchObject(preserved);
  });

  it("settles queued final custody through an actor rebase while participant writes queue", async () => {
    await settle("queued", ["prepared"]);
    const competingWrites: Promise<unknown>[] = [];
    const createActor = sessionActors.createSessionActor;
    vi.spyOn(sessionActors, "createSessionActor").mockImplementation((params) => {
      const actor = createActor(params);
      if (params.target.sessionKey === sessionKey) {
        const settleActor = actor.deliverySettled;
        vi.spyOn(actor, "deliverySettled").mockImplementationOnce(async (...command) => {
          const recordParticipant = (promptedAt: number) =>
            recordSessionParticipantInWorker(
              { ...sessionScope(), agentId: "main" },
              {
                identity: {
                  type: "observation",
                  pluginId: null,
                  accountId: null,
                  senderKind: "unknown",
                  id: "gateway-client",
                },
                promptedAt,
                sessionAgentId: "main",
              },
            );
          await recordParticipant(1);
          const pending = settleActor(...command);
          competingWrites.push(runOutsideStoreWriterContext(() => recordParticipant(2)));
          const outcome = await pending;
          expect(outcome).toMatchObject({
            kind: "stale-version",
            postimage: { target: actor.target },
          });
          return outcome;
        });
      }
      return actor;
    });
    try {
      await check("delivered", undefined, ["queued"]);
      await Promise.all(competingWrites);
      expect(read()?.pendingFinalDelivery?.deliveries).toEqual(deliveries("delivered"));
      expect(wake).toHaveBeenCalledOnce();
    } finally {
      await Promise.all(competingWrites);
    }
  });

  it("admits current custody in one command without a preparatory read", async () => {
    const original = read()!;
    const pending = original.pendingFinalDelivery!;
    const changedPending = (fields: PendingUpdate) => ({
      pendingFinalDelivery: { ...pending, ...fields },
    });
    const beforeCommand = vi.fn<() => void>();
    const commands = observeActorCommands({ beforeCommand });
    for (const change of [
      { label: "foreign metadata" },
      { sessionId: "replacement" },
      changedPending({ intentId: "replacement-intent" }),
      changedPending({ deliveries: deliveries("queued") }),
      changedPending({ deliveries: [{ id: "replacement-delivery", state: "prepared" }] }),
    ]) {
      writeSync(original);
      let foreign: InternalSessionEntry | undefined;
      beforeCommand.mockImplementationOnce(() => {
        writeSync({ ...original, ...change });
        foreign = read();
      });
      commands.length = 0;
      await check("queued", "label" in change ? "queued" : "stale", ["prepared"]);
      expect(commands).toEqual(["session.actor.deliverySettled"]);
      if ("label" in change) {
        expect(read()).toMatchObject({
          label: "foreign metadata",
          mainRestartRecovery: { revision: 2 },
          pendingFinalDelivery: { deliveries: deliveries("queued") },
        });
      } else {
        expect(read()).toEqual(foreign);
      }
    }
    expect(wake).not.toHaveBeenCalled();
  });

  const noticeContext = { channel: "telegram", to: "chat-1", accountId: "default" };

  const installContextOnPendingFinal = () => updatePending({ context: noticeContext });

  it("rechecks live host authority at actor commit and records exact identified completion", async () => {
    await installContextOnPendingFinal();
    const initial = read();
    const claim: HarnessCompletionRecovery = {
      taskId: "child-session",
      taskRunId: "child-run",
      taskStatus: "succeeded",
      sourceRunId: "announce:child-run",
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      sessionId,
    };
    const ownedCompletion = {
      ...completion,
      agentId: "main",
      sessionWriterDeliveryAuthority: {
        ...sessionScope(),
        agentId: "main",
        expectedSessionId: sessionId,
        harnessCompletion: claim,
      },
    };
    const owed = vi
      .spyOn(harnessRecovery, "getOwedHarnessCompletionTask")
      .mockReturnValue(undefined);
    const beforeCommit = vi.fn<() => void>();
    const commands = observeActorCommands({ beforeCommit });
    await expect(
      settlePendingFinalDelivery({ ...ownedCompletion, intentId: "different" }, "delivered"),
    ).resolves.toEqual({ state: "stale" });
    expect(owed).not.toHaveBeenCalled();
    await expect(settlePendingFinalDelivery(ownedCompletion, "delivered")).resolves.toEqual({
      state: "stale",
    });
    expect(owed).toHaveBeenCalledOnce();
    expect(read()).toEqual(initial);
    expect(wake).not.toHaveBeenCalled();

    owed.mockReturnValue(claim);
    beforeCommit.mockImplementationOnce(() => {
      owed.mockReturnValue(undefined);
    });
    await expect(
      settlePendingFinalDelivery(ownedCompletion, "delivered", ["prepared"], {
        identifiedResult: { channel: "telegram", messageId: "revoked-final" },
      }),
    ).resolves.toEqual({ state: "stale" });
    expect(read()).toEqual(initial);
    expect(wake).not.toHaveBeenCalled();

    owed.mockReturnValue(claim);
    commands.length = 0;
    await expect(
      settlePendingFinalDelivery(ownedCompletion, "delivered", ["prepared"], {
        identifiedResult: { channel: "telegram", messageId: "platform-final" },
      }),
    ).resolves.toEqual({ state: "delivered" });
    expect(commands.filter((command) => command !== "session.actor.read")).toEqual([
      "session.actor.deliverySettled",
    ]);
    expect(owed).toHaveBeenLastCalledWith(claim, expect.objectContaining(initial!));
    expect(read()).toMatchObject({
      pendingFinalDelivery: { deliveries: deliveries("delivered") },
      restartRecoveryTerminalDeliveryEvidence: [
        {
          harnessCompletion: claim,
          durableFinalReceipt: { intentId, deliveryId, platformMessageId: "platform-final" },
        },
      ],
    });
  });

  it.each(["unknown", "delivered", "prepared", "suppressed"] as const)(
    "tracks notice debt when ambiguous custody becomes %s",
    async (state) => {
      await installContextOnPendingFinal();
      if (state === "delivered") {
        await settle("queued", ["prepared"]);
      }
      await settle("unknown", ["prepared", "queued"]);
      if (state === "unknown") {
        const notice = read()?.pendingDeliveryNotice;
        expect(notice).toMatchObject({
          intentId,
          state: "owed",
          context: noticeContext,
        });
        await check(state, undefined, ["queued", "unknown"]);
        expect(read()?.pendingDeliveryNotice).toEqual(notice);
      } else if (state === "prepared") {
        await check(state, undefined, ["queued", "unknown"]);
      } else if (state === "suppressed") {
        await expect(
          settleDurableDelivery(completion, { rejectionError: "payload rejected" }),
        ).resolves.toEqual({ state });
      } else {
        await check(state);
      }
      if (state !== "unknown") {
        expectPendingWithoutNotice(state);
      }
    },
  );

  it.each(["owed", "unresolved", "acknowledged"] as const)(
    "preserves %s notice history while another delivery remains unknown",
    async (noticeState) => {
      await installContextOnPendingFinal();
      const entry = read()!;
      await updatePending(
        { deliveries: [...deliveries("unknown"), { id: "delivery-2", state: "queued" }] },
        {
          pendingDeliveryNotice: {
            createdAt: entry.pendingFinalDelivery!.createdAt,
            context: noticeContext,
            intentId,
            state: noticeState,
          },
        },
      );
      await settle("delivered", undefined, undefined, { ...completion, deliveryId: "delivery-2" });
      expect(read()?.pendingDeliveryNotice?.state).toBe(noticeState);
      await settle("unknown");
      expect(read()?.pendingDeliveryNotice?.state).toBe(noticeState);
      await settle("delivered");
      expect(read()?.pendingDeliveryNotice?.state).toBe(
        noticeState === "acknowledged" ? "acknowledged" : undefined,
      );
    },
  );

  it("carries the custom queue root when a terminal sibling wakes recovery", async () => {
    const entry = read()!;
    const target = { ...sessionScope(), storePath: path.join(tmpDir, "custom-agent.sqlite") };
    const customScope = { ...target, env: resolveDeliveryQueueStateEnv(tmpDir) };
    const customCompletion = { ...completion, ...target };
    await updatePending(
      { deliveries: [...deliveries("prepared"), { id: "delivery-2", state: "queued" }] },
      {},
      customScope,
    );

    await check("delivered", undefined, undefined, { stateDir: tmpDir }, customCompletion);
    expect(wake).toHaveBeenCalledWith({ ...target, sessionId, stateDir: tmpDir });
    expect(read(customScope)?.pendingFinalDelivery?.deliveries).toEqual([
      { id: deliveryId, state: "delivered" },
      { id: "delivery-2", state: "queued" },
    ]);
    expect(read()).toEqual(entry);
  });
});
