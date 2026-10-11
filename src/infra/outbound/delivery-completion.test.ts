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
import type { InternalSessionEntry } from "../../config/sessions/types.js";
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
  const observer = vi
    .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
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
    });
  const admissionObserver = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((authorize, attachment) =>
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
  return {
    commands,
    restore() {
      admissionObserver.mockRestore();
      observer.mockRestore();
    },
  };
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
      pendingFinalDelivery: {
        kind: "replayable",
        text: "durable final",
        createdAt: Date.now(),
        intentId: completion.intentId,
        deliveries: [{ id: completion.deliveryId, state: "prepared" }],
      },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  });

  afterEach(async () => {
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("invalidates an earlier recovery decision and wakes the exact session", async () => {
    const observation = { sessionId: completion.sessionId, cycleId: "cycle-1", revision: 1 };

    const sql = observeHostDataSql();
    try {
      await expect(settlePendingFinalDelivery(completion, "delivered")).resolves.toEqual({
        state: "delivered",
      });
      expect(
        sql.queries.filter((query) =>
          /session_nodes|session_entry_snapshots|\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      mainRestartRecovery: { revision: 2 },
      pendingFinalDelivery: {
        deliveries: [{ id: completion.deliveryId, state: "delivered" }],
      },
    });
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith({
      sessionId: completion.sessionId,
      sessionKey,
      storePath,
    });
    recoveryMocks.scheduleMainSessionRecoveryPendingTarget.mockClear();
    const completed = loadSessionEntry({ sessionKey, storePath });
    await expect(settlePendingFinalDelivery(completion, "delivered")).resolves.toEqual({
      state: "delivered",
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(completed);
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

  it("settles native incognito custody on its retained memory owner", async () => {
    const nativePath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tmpDir },
    });
    const scope = { sessionKey, storePath: nativePath, env: { OPENCLAW_STATE_DIR: tmpDir } };
    const nativeCompletion = { ...completion, storePath: nativePath };
    try {
      await replaceSessionEntry(scope, {
        sessionId: completion.sessionId,
        incognito: true,
        updatedAt: 1,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "private final",
          createdAt: 1,
          intentId: completion.intentId,
          deliveries: [{ id: completion.deliveryId, state: "prepared" }],
        },
      });
      await expect(
        settlePendingFinalDelivery(nativeCompletion, "queued", ["prepared"], { stateDir: tmpDir }),
      ).resolves.toEqual({ state: "queued" });
      expect(loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "queued" },
      ]);
      await expect(
        settlePendingFinalDelivery(nativeCompletion, "delivered", ["queued"], { stateDir: tmpDir }),
      ).resolves.toEqual({ state: "delivered" });
      expect(loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "delivered" },
      ]);
      await expect(
        settlePendingFinalDelivery(nativeCompletion, "queued", ["prepared"], { stateDir: tmpDir }),
      ).resolves.toEqual({ state: "stale" });
      expect(loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "delivered" },
      ]);
      await expect(fs.stat(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await disposeOpenClawAgentDatabaseByPath(nativePath);
    }
  });

  it("records queue custody without waking recovery", async () => {
    await expect(settlePendingFinalDelivery(completion, "queued", ["prepared"])).resolves.toEqual({
      state: "queued",
    });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      mainRestartRecovery: { revision: 2 },
      pendingFinalDelivery: {
        deliveries: [{ id: completion.deliveryId, state: "queued" }],
      },
    });
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();
  });

  it("admits current custody in one command without a preparatory read", async () => {
    const scope = { sessionKey, storePath };
    const original = loadSessionEntry(scope)!;
    const pending = original.pendingFinalDelivery!;
    let changeBeforeCommit: (() => void) | undefined;
    const observed = observeActorCommands({
      beforeCommand() {
        const change = changeBeforeCommit;
        changeBeforeCommit = undefined;
        change?.();
      },
    });
    try {
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
        observed.commands.length = 0;
        await expect(
          settlePendingFinalDelivery(completion, "queued", ["prepared"]),
        ).resolves.toEqual({
          state: "label" in change ? "queued" : "stale",
        });
        expect(observed.commands).toEqual(["session.actor.deliverySettled"]);
        if ("label" in change) {
          expect(loadSessionEntry(scope)).toMatchObject({
            label: "foreign metadata",
            mainRestartRecovery: { revision: 2 },
            pendingFinalDelivery: {
              deliveries: [{ id: completion.deliveryId, state: "queued" }],
            },
          });
        } else {
          expect(loadSessionEntry(scope)).toEqual(foreign);
        }
      }
      expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();
    } finally {
      observed.restore();
    }
  });

  const noticeContext = { channel: "telegram", to: "chat-1", accountId: "default" };

  async function installContextOnPendingFinal() {
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        pendingFinalDelivery: { ...entry.pendingFinalDelivery!, context: noticeContext },
      },
    );
  }

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
    const observed = observeActorCommands({
      beforeCommit() {
        if (revokeBeforeCommit) {
          revokeBeforeCommit = false;
          owed.mockReturnValue(undefined);
        }
      },
    });
    try {
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
      observed.commands.length = 0;
      await expect(
        settlePendingFinalDelivery(ownedCompletion, "delivered", ["prepared"], {
          identifiedResult: { channel: "telegram", messageId: "platform-final" },
        }),
      ).resolves.toEqual({ state: "delivered" });
      expect(observed.commands.filter((command) => command !== "session.actor.read")).toEqual([
        "session.actor.deliverySettled",
      ]);
      expect(owed).toHaveBeenLastCalledWith(claim, expect.objectContaining(initial!));
      expect(loadSessionEntry(scope)).toMatchObject({
        pendingFinalDelivery: { deliveries: [{ id: completion.deliveryId, state: "delivered" }] },
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
    } finally {
      observed.restore();
      owed.mockRestore();
    }
  });

  it("owes a notice when claimed custody is affirmed unknown", async () => {
    await installContextOnPendingFinal();
    await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toBeUndefined();

    await expect(
      settlePendingFinalDelivery(completion, "unknown", ["queued", "unknown"]),
    ).resolves.toEqual({ state: "unknown" });

    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: completion.intentId,
      state: "owed",
      context: noticeContext,
    });
  });

  it("does not owe a notice for the pre-dispatch claim or terminal outcomes", async () => {
    await installContextOnPendingFinal();
    await settlePendingFinalDelivery(completion, "queued", ["prepared"]);
    await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);
    await settlePendingFinalDelivery(completion, "delivered");

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingDeliveryNotice).toBeUndefined();
    expect(entry?.pendingFinalDelivery).toMatchObject({
      deliveries: [{ id: completion.deliveryId, state: "delivered" }],
    });
  });

  it("restores prepared custody for a retryable no-send so recovery can replay", async () => {
    await installContextOnPendingFinal();
    await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);

    await expect(
      settlePendingFinalDelivery(completion, "prepared", ["queued", "unknown"]),
    ).resolves.toEqual({ state: "prepared" });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingDeliveryNotice).toBeUndefined();
    expect(entry?.pendingFinalDelivery).toMatchObject({
      deliveries: [{ id: completion.deliveryId, state: "prepared" }],
    });
  });

  it("settles a proven pre-dispatch rejection as suppressed without notice debt", async () => {
    await installContextOnPendingFinal();
    await settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]);

    await expect(
      settleDurableDelivery(completion, { rejectionError: "payload rejected" }),
    ).resolves.toEqual({ state: "suppressed" });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.pendingDeliveryNotice).toBeUndefined();
    expect(entry?.pendingFinalDelivery).toMatchObject({
      deliveries: [{ id: completion.deliveryId, state: "suppressed" }],
    });
  });

  it.each(["owed", "unresolved", "acknowledged"] as const)(
    "preserves %s notice history while another delivery remains unknown",
    async (noticeState) => {
      await installContextOnPendingFinal();
      const entry = loadSessionEntry({ sessionKey, storePath })!;
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          ...entry,
          pendingFinalDelivery: {
            ...entry.pendingFinalDelivery!,
            deliveries: [
              { id: completion.deliveryId, state: "unknown" },
              { id: "delivery-2", state: "queued" },
            ],
          },
          pendingDeliveryNotice: {
            createdAt: entry.pendingFinalDelivery!.createdAt,
            context: noticeContext,
            intentId: completion.intentId,
            state: noticeState,
          },
        },
      );
      await settlePendingFinalDelivery({ ...completion, deliveryId: "delivery-2" }, "delivered");
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice?.state).toBe(
        noticeState,
      );
      await settlePendingFinalDelivery(completion, "unknown");
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice?.state).toBe(
        noticeState,
      );
      await settlePendingFinalDelivery(completion, "delivered");
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice?.state).toBe(
        noticeState === "acknowledged" ? "acknowledged" : undefined,
      );
    },
  );

  it("carries the custom queue root when a terminal sibling wakes recovery", async () => {
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    const customStorePath = path.join(tmpDir, "custom-agent.sqlite");
    const customScope = {
      sessionKey,
      storePath: customStorePath,
      env: resolveDeliveryQueueStateEnv(tmpDir),
    };
    await replaceSessionEntry(customScope, {
      ...entry,
      pendingFinalDelivery: {
        ...entry.pendingFinalDelivery!,
        deliveries: [
          { id: completion.deliveryId, state: "prepared" },
          { id: "delivery-2", state: "queued" },
        ],
      },
    });

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
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(entry);
  });
});
