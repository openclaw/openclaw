import path from "node:path";
import { assert, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { RecoveryNoticePredicate } from "./recovery-notice.js";
import { loadTranscriptEvents } from "./session-accessor.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import type { SqliteSessionTurnOptions } from "./session-turn.types.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import type { InternalSessionEntry } from "./types.js";

const destination = { channel: "reef", to: "reef:recipient", accountId: "default", threadId: 42 };
const recovery = {
  cycleId: "cycle",
  revision: 4,
  chargedAttempts: 3,
  tombstone: { reason: "exhausted" },
};
const notice = {
  role: "assistant",
  provider: "openclaw",
  model: "delivery-mirror",
  idempotencyKey: "notice",
  content: [
    { type: "text", text: "Recovery stopped." },
    { type: "text", text: "\nSaved reply (delivery unconfirmed):\nPrivate draft." },
  ],
  openclawDeliveryMirror: {
    kind: "restart-recovery-notice",
    noticeId: "notice",
    noticePart: 0,
    cycleId: recovery.cycleId,
    revision: recovery.revision,
    destination,
  },
};
const cases = [
  "accepted",
  "append",
  "cycle",
  "revision",
  "recovered",
  "anchor",
  "idempotency",
  "route",
  "changed-text",
  "hidden-changed-text",
  "archived",
  "initializing",
  "workspace",
  "expired",
] as const;

for (const backend of ["sqlite", "memory"] as const) {
  it.each(cases)(`${backend} validates accepted notice custody at commit: %s`, async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:recovery",
        sessionId: "recovery-session",
        storePath:
          backend === "memory"
            ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: process.env })
            : path.join(stateDir, "sessions.json"),
      };
      const entry: InternalSessionEntry = {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        ...(backend === "memory" ? { incognito: true } : {}),
        mainRestartRecovery: recovery,
        ...(scenario === "archived" ? { archivedAt: 1 } : {}),
        ...(scenario === "initializing" ? { initializationPending: true } : {}),
        ...(scenario === "workspace"
          ? { pendingProjectGitUrl: "https://example.invalid/project.git" }
          : {}),
        ...(scenario === "expired" ? { incognito: true, createdAt: 1 } : {}),
      };
      const append = (
        options: Omit<SqliteSessionTurnOptions, "expectedSessionId" | "sessionFile">,
      ) =>
        appendExpectedSessionTranscriptTurn(scope, {
          expectedSessionId: scope.sessionId,
          sessionFile: "synthetic.jsonl",
          config: {},
          ...options,
        });
      try {
        const local = await append({ initialSessionEntry: entry, messages: [{ message: notice }] });
        const anchor = local.appendedMessages[0]?.anchor;
        assert(anchor);
        const predicate: RecoveryNoticePredicate = {
          kind: "recovery-notice",
          noticeId: "notice",
          anchor,
          destination: { ...destination, threadId: "42" },
        };
        // The receipt captured this row before another append or lifecycle transition won.
        if (["append", "cycle", "revision", "recovered"].includes(scenario)) {
          await append({
            messages: [{ message: { role: "user", content: "Later input" } }],
            ...(scenario === "append"
              ? {}
              : {
                  sessionLifecyclePatch: {
                    mainRestartRecovery: {
                      ...recovery,
                      ...(scenario === "cycle" ? { cycleId: "new-cycle" } : {}),
                      ...(scenario === "revision" ? { revision: 5 } : {}),
                      ...(scenario === "recovered"
                        ? {
                            tombstone: {
                              ...recovery.tombstone,
                              recoveredSessionKey: "agent:main:dashboard:replacement",
                            },
                          }
                        : {}),
                    },
                  },
                }),
          });
        }
        if (scenario === "anchor") {
          predicate.anchor = { ...anchor, rawSeq: anchor.rawSeq + 1 };
        }
        if (scenario === "idempotency") {
          predicate.noticeId = "different-notice";
        }
        if (scenario === "route") {
          predicate.destination = { ...destination, threadId: 43 };
        }
        const text = scenario.includes("changed-text")
          ? "Actual normalized notice."
          : "Recovery stopped.";
        const message = {
          role: "assistant",
          model: "automation-result",
          provider: "openclaw",
          idempotencyKey: "accepted-notice",
          openclawAutomation: { kind: "recovery-notice", noticeId: "notice", localNotice: anchor },
          content: [{ type: "text", text }],
          ...(scenario === "changed-text" ? {} : { display: false }),
        };
        const before = await loadTranscriptEvents(scope);
        const commit = () => append({ messages: [{ message, predicate }] });
        if (["accepted", "append", "changed-text"].includes(scenario)) {
          expect((await commit()).appendedMessages).toHaveLength(1);
          const after = await loadTranscriptEvents(scope);
          expect(after.slice(0, before.length)).toEqual(before);
          expect((await commit()).appendedMessages[0]?.appended).toBe(false);
          expect(await loadTranscriptEvents(scope)).toEqual(after);
        } else {
          await expect(commit()).rejects.toThrow();
          expect(await loadTranscriptEvents(scope)).toEqual(before);
        }
        expect(
          resolveSessionWorkStartError(scope.sessionKey, entry, {
            purpose: "accepted-result-settlement",
          }),
        ).toBeDefined();
      } finally {
        memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
        await closeOpenClawAgentDatabasesAsync();
      }
    });
  });
}
