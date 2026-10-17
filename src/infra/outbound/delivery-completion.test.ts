import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as harnessRecovery from "../../agents/agent-harness-completion-recovery.js";
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
import * as workerAdmission from "../sqlite-worker-operation-admission.js";
import { settleDurableDelivery, settlePendingFinalDelivery } from "./delivery-completion.js";

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

function observeActorCommands(
  hooks: {
    beforeCommand?: () => void;
    beforeCommit?: () => void;
  } = {},
) {
  const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const commands: string[] = [];
  vi.spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
    (...args) => {
      const owner = capture(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, run, options) =>
          owner.runExisting(
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
          ),
      };
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
  const completion = {
    kind: "pending-final" as const,
    deliveryId: "delivery-1",
    intentId: "intent-1",
    sessionId: "session-1",
    sessionKey,
    storePath: "",
  };

  const read = () => loadSessionEntry({ sessionKey, storePath });
  const deliveries = (state: "prepared" | "queued" | "delivered" | "unknown" | "suppressed") => [
    { id: completion.deliveryId, state },
  ];
  async function expectSettlement(
    state: Parameters<typeof settlePendingFinalDelivery>[1],
    expectedStates?: Parameters<typeof settlePendingFinalDelivery>[2],
    options?: Parameters<typeof settlePendingFinalDelivery>[3],
    target = completion,
    result: string = state,
  ) {
    await expect(
      settlePendingFinalDelivery(target, state, expectedStates, options),
    ).resolves.toEqual({ state: result });
  }

  const finalDelivery = (state: Parameters<typeof deliveries>[0] = "prepared") => ({
    kind: "replayable" as const,
    text: "durable final",
    createdAt: Date.now(),
    intentId: completion.intentId,
    deliveries: deliveries(state),
  });

  async function updatePending(
    pending: Partial<NonNullable<InternalSessionEntry["pendingFinalDelivery"]>>,
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
    const entry: InternalSessionEntry = {
      sessionId: completion.sessionId,
      status: "interrupted",
      abortedLastRun: true,
      updatedAt: Date.now(),
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
      },
      pendingFinalDelivery: finalDelivery(),
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("invalidates an earlier recovery decision and wakes the exact session", async () => {
    const observation = { sessionId: completion.sessionId, cycleId: "cycle-1", revision: 1 };

    const sql = observeHostDataSql();
    try {
      await expectSettlement("delivered");
      expect(
        sql.queries.filter((query) =>
          /session_nodes|session_entry_snapshots|\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }

    expect(read()).toMatchObject({
      mainRestartRecovery: { revision: 2 },
      pendingFinalDelivery: {
        deliveries: deliveries("delivered"),
      },
    });
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith({
      sessionId: completion.sessionId,
      sessionKey,
      storePath,
    });
    recoveryMocks.scheduleMainSessionRecoveryPendingTarget.mockClear();
    const completed = read();
    await expectSettlement("delivered");
    expect(read()).toEqual(completed);
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();
    await expect(
      commitMainSessionRecovery({
        command: {
          kind: "tombstone",
          now: Date.now(),
          observation,
          reason: "stale delivery decision",
        },
        requireWriteSuccess: true,
        target: { sessionKey, storePath },
      }),
    ).resolves.toMatchObject({ transition: { kind: "rejected", reason: "stale_revision" } });
  });

  it("settles incognito custody on its retained memory owner", async () => {
    const incognitoKey = "agent:main:dashboard:incognito-delivery";
    const nativePath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tmpDir },
    });
    const scope = {
      sessionKey: incognitoKey,
      storePath: nativePath,
      env: { OPENCLAW_STATE_DIR: tmpDir },
    };
    const nativeCompletion = { ...completion, sessionKey: incognitoKey, storePath: nativePath };
    try {
      await replaceSessionEntry(scope, {
        sessionId: completion.sessionId,
        incognito: true,
        updatedAt: 1,
        pendingFinalDelivery: { ...finalDelivery(), text: "private final", createdAt: 1 },
      });
      for (const [state, from, result] of [
        ["queued", "prepared", "queued"],
        ["delivered", "queued", "delivered"],
        ["queued", "prepared", "stale"],
      ] as const) {
        await expectSettlement(state, [from], { stateDir: tmpDir }, nativeCompletion, result);
        expect(loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries).toEqual(
          deliveries(result === "stale" ? "delivered" : result),
        );
      }
      await expect(fs.stat(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await disposeOpenClawAgentDatabaseByPath(nativePath);
    }
  });

  it("rolls back settled delivery and cleanup together without losing an intervening write", async () => {
    const scope = { sessionKey, storePath };
    const initial = loadSessionEntry(scope)!;
    let writeBeforeCommand = true;
    let failCommit = true;
    observeActorCommands({
      beforeCommand() {
        if (writeBeforeCommand) {
          writeBeforeCommand = false;
          replaceSessionEntrySync(scope, { ...initial, label: "committed while delivery settled" });
        }
      },
      beforeCommit() {
        if (failCommit) {
          throw new Error("synthetic crash before delivery cleanup commit");
        }
      },
    });
    const options = { preserveActivity: true, clearAfterSettled: {} };
    await expect(
      settlePendingFinalDelivery(completion, "delivered", ["prepared"], options),
    ).rejects.toThrow("synthetic crash before delivery cleanup commit");
    expect(loadSessionEntry(scope)).toMatchObject({
      label: "committed while delivery settled",
      pendingFinalDelivery: initial.pendingFinalDelivery,
      updatedAt: initial.updatedAt,
    });
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();

    failCommit = false;
    await expectSettlement("delivered", ["prepared"], options);
    const settled = loadSessionEntry(scope);
    expect(settled?.pendingFinalDelivery).toBeUndefined();
    expect(settled).toMatchObject({
      label: "committed while delivery settled",
      updatedAt: initial.updatedAt,
    });
  });

  it("settles queued final custody through an actor rebase while participant writes queue", async () => {
    await settlePendingFinalDelivery(completion, "queued", ["prepared"]);
    const scope = { agentId: "main", sessionKey, storePath };
    const competingWrites: Promise<unknown>[] = [];
    const createActor = sessionActors.createSessionActor;
    vi.spyOn(sessionActors, "createSessionActor").mockImplementation((params) => {
      const actor = createActor(params);
      if (params.target.sessionKey === sessionKey) {
        const settle = actor.deliverySettled;
        vi.spyOn(actor, "deliverySettled").mockImplementationOnce(async (...command) => {
          const recordParticipant = (promptedAt: number) =>
            recordSessionParticipantInWorker(scope, {
              identity: {
                type: "observation",
                pluginId: null,
                accountId: null,
                senderKind: "unknown",
                id: "gateway-client",
              },
              promptedAt,
              sessionAgentId: "main",
            });
          await recordParticipant(1);
          const pending = settle(...command);
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
      await expectSettlement("delivered", ["queued"]);
      await Promise.all(competingWrites);
      expect(loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries).toEqual(
        deliveries("delivered"),
      );
      expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledOnce();
    } finally {
      await Promise.all(competingWrites);
    }
  });

  it("admits current custody in one command without a preparatory read", async () => {
    const scope = { sessionKey, storePath };
    const original = loadSessionEntry(scope)!;
    const pending = original.pendingFinalDelivery!;
    let changeBeforeCommit: (() => void) | undefined;
    const commands = observeActorCommands({
      beforeCommand() {
        const change = changeBeforeCommit;
        changeBeforeCommit = undefined;
        change?.();
      },
    });
    for (const change of [
      { label: "foreign metadata" },
      { sessionId: "replacement" },
      { pendingFinalDelivery: { ...pending, intentId: "replacement-intent" } },
      {
        pendingFinalDelivery: {
          ...pending,
          deliveries: [{ id: completion.deliveryId, state: "queued" as const }],
        },
      },
      {
        pendingFinalDelivery: {
          ...pending,
          deliveries: [{ id: "replacement-delivery", state: "prepared" as const }],
        },
      },
    ]) {
      replaceSessionEntrySync(scope, original);
      let foreign: InternalSessionEntry | undefined;
      changeBeforeCommit = () => {
        replaceSessionEntrySync(scope, { ...original, ...change });
        foreign = loadSessionEntry(scope);
      };
      commands.length = 0;
      await expect(settlePendingFinalDelivery(completion, "queued", ["prepared"])).resolves.toEqual(
        {
          state: "label" in change ? "queued" : "stale",
        },
      );
      expect(commands).toEqual(["session.actor.deliverySettled"]);
      if ("label" in change) {
        expect(loadSessionEntry(scope)).toMatchObject({
          label: "foreign metadata",
          mainRestartRecovery: { revision: 2 },
          pendingFinalDelivery: {
            deliveries: deliveries("queued"),
          },
        });
      } else {
        expect(loadSessionEntry(scope)).toEqual(foreign);
      }
    }
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();
  });

  const noticeContext = { channel: "telegram", to: "chat-1", accountId: "default" };

  const installContextOnPendingFinal = () => updatePending({ context: noticeContext });

  it("rechecks live host authority at actor commit and records exact identified completion", async () => {
    await installContextOnPendingFinal();
    const scope = { sessionKey, storePath };
    const initial = loadSessionEntry(scope);
    const claim: HarnessCompletionRecovery = {
      taskId: "child-session",
      taskRunId: "child-run",
      taskStatus: "succeeded",
      sourceRunId: "announce:child-run",
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      sessionId: completion.sessionId,
    };
    const ownedCompletion = {
      ...completion,
      agentId: "main",
      sessionWriterDeliveryAuthority: {
        agentId: "main",
        expectedSessionId: completion.sessionId,
        sessionKey,
        storePath,
        harnessCompletion: claim,
      },
    };
    const owed = vi
      .spyOn(harnessRecovery, "getOwedHarnessCompletionTask")
      .mockReturnValue(undefined);
    let revokeBeforeCommit = false;
    const commands = observeActorCommands({
      beforeCommit() {
        if (revokeBeforeCommit) {
          revokeBeforeCommit = false;
          owed.mockReturnValue(undefined);
        }
      },
    });
    await expect(
      settlePendingFinalDelivery({ ...ownedCompletion, intentId: "different" }, "delivered"),
    ).resolves.toEqual({ state: "stale" });
    expect(owed).not.toHaveBeenCalled();
    await expect(settlePendingFinalDelivery(ownedCompletion, "delivered")).resolves.toEqual({
      state: "stale",
    });
    expect(owed).toHaveBeenCalledOnce();
    expect(loadSessionEntry(scope)).toEqual(initial);
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();

    owed.mockReturnValue(claim);
    revokeBeforeCommit = true;
    await expect(
      settlePendingFinalDelivery(ownedCompletion, "delivered", ["prepared"], {
        identifiedResult: { channel: "telegram", messageId: "revoked-final" },
      }),
    ).resolves.toEqual({ state: "stale" });
    expect(loadSessionEntry(scope)).toEqual(initial);
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();

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
    expect(loadSessionEntry(scope)).toMatchObject({
      pendingFinalDelivery: { deliveries: deliveries("delivered") },
      restartRecoveryTerminalDeliveryEvidence: [
        {
          harnessCompletion: claim,
          durableFinalReceipt: {
            intentId: completion.intentId,
            deliveryId: completion.deliveryId,
            platformMessageId: "platform-final",
          },
        },
      ],
    });
  });

  it.each(["unknown", "delivered", "prepared", "suppressed"] as const)(
    "tracks notice debt when ambiguous custody becomes %s",
    async (state) => {
      await installContextOnPendingFinal();
      if (state === "delivered") {
        await settlePendingFinalDelivery(completion, "queued", ["prepared"]);
      }
      await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);
      if (state === "unknown") {
        const notice = read()?.pendingDeliveryNotice;
        expect(notice).toMatchObject({
          intentId: completion.intentId,
          state: "owed",
          context: noticeContext,
        });
        await expectSettlement(state, ["queued", "unknown"]);
        expect(read()?.pendingDeliveryNotice).toEqual(notice);
      } else if (state === "prepared") {
        await expectSettlement(state, ["queued", "unknown"]);
      } else if (state === "suppressed") {
        await expect(
          settleDurableDelivery(completion, { rejectionError: "payload rejected" }),
        ).resolves.toEqual({ state });
      } else {
        await expectSettlement(state);
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
            intentId: completion.intentId,
            state: noticeState,
          },
        },
      );
      await settlePendingFinalDelivery({ ...completion, deliveryId: "delivery-2" }, "delivered");
      expect(read()?.pendingDeliveryNotice?.state).toBe(noticeState);
      await settlePendingFinalDelivery(completion, "unknown");
      expect(read()?.pendingDeliveryNotice?.state).toBe(noticeState);
      await settlePendingFinalDelivery(completion, "delivered");
      expect(read()?.pendingDeliveryNotice?.state).toBe(
        noticeState === "acknowledged" ? "acknowledged" : undefined,
      );
    },
  );

  it("carries the custom queue root when a terminal sibling wakes recovery", async () => {
    const entry = read()!;
    const customStorePath = path.join(tmpDir, "custom-agent.sqlite");
    const customScope = {
      sessionKey,
      storePath: customStorePath,
      env: resolveDeliveryQueueStateEnv(tmpDir),
    };
    await updatePending(
      { deliveries: [...deliveries("prepared"), { id: "delivery-2", state: "queued" }] },
      {},
      customScope,
    );

    await expect(
      settlePendingFinalDelivery(
        { ...completion, storePath: customStorePath },
        "delivered",
        undefined,
        {
          stateDir: tmpDir,
        },
      ),
    ).resolves.toEqual({ state: "delivered" });

    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith({
      sessionId: completion.sessionId,
      sessionKey,
      stateDir: tmpDir,
      storePath: customStorePath,
    });
    expect(loadSessionEntry(customScope)?.pendingFinalDelivery?.deliveries).toEqual([
      { id: completion.deliveryId, state: "delivered" },
      { id: "delivery-2", state: "queued" },
    ]);
    expect(read()).toEqual(entry);
  });
});
