import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSubagentTaskMessage } from "../agents/subagents/spawn/subagent-system-prompt.js";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { resolveStateDir } from "../config/paths.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  changedStoreFiles,
  snapshotStoreFiles,
} from "../test-utils/store-snapshot.test-support.js";
import { repairLegacySessionTitles } from "./doctor-session-title-repair.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
const cfg = { agents: { entries: { main: {} } } };
const title = "Investigate why the gateway times out";
const user = (content: string) => ({ role: "user", content });
const messages = [user(title), { role: "assistant", content: "reply" }];
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
}));

beforeEach(() => generateConversationLabelWithFallback.mockReset());
afterEach(() => vi.restoreAllMocks());

async function withSession(
  run: (params: sessionAccessor.SessionTranscriptRuntimeScope) => Promise<void>,
  transcript: Array<{ role: string; content: string; provenance?: unknown }> = messages,
  sessionKey = "agent:main:dashboard:legacy",
) {
  await withOpenClawTestState({ scenario: "minimal", label: "doctor-title" }, async (state) => {
    setRuntimeConfigSnapshot(cfg);
    const params = {
      agentId: "main",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      sessionKey,
      sessionId: "legacy-session",
      lifecycleRevision: "legacy-lifecycle",
    };
    await sessionAccessor.persistSessionTranscriptTurn(params, {
      messages: transcript.map((message) => ({ message })),
      touchSessionEntry: false,
    });
    await sessionAccessor.replaceSessionEntry(params, {
      sessionId: params.sessionId,
      lifecycleRevision: params.lifecycleRevision,
      status: "done",
      updatedAt: 12,
      lastActivityAt: 11,
      lastInteractionAt: 10,
    });
    await run(params);
  });
}

function repair() {
  return noteSessionTranscriptHealth({
    cfg,
    shouldRepair: true,
    postSessionPluginMigrationPlanBound: true,
  });
}

it("preserves native child names while repairing ordinary sessions in the same scan", async () => {
  await withSession(
    async (params) => {
      const task = "Investigate the gateway timeout";
      const fixtures: Array<{
        sessionKey: string;
        message: string;
        entry?: Partial<SessionEntry>;
        displayName?: string;
      }> = [
        ...(["run", "session"] as const).flatMap((spawnMode) => {
          const historical = `[Subagent Context] You are running as a subagent.\n\n[Subagent Task]\n\n${task}`;
          const current = buildSubagentTaskMessage({
            task,
            spawnMode,
            childDepth: 1,
            maxSpawnDepth: 5,
          });
          return [historical, current].map((message, index) => ({
            sessionKey: `agent:main:subagent:${spawnMode}-${index}:thread:child`,
            message,
          }));
        }),
        {
          sessionKey: "agent:main:subagent:named",
          message: task,
          entry: { label: "Explicit child label" },
          displayName: undefined,
        },
        {
          sessionKey: "agent:main:dashboard:child",
          message: task,
          entry: {},
          displayName: task,
        },
      ];
      const expected = new Map<string, SessionEntry>();
      for (const [index, fixture] of fixtures.entries()) {
        const scope = { ...params, sessionKey: fixture.sessionKey, sessionId: `child-${index}` };
        await sessionAccessor.persistSessionTranscriptTurn(scope, {
          messages: [{ message: user(fixture.message) }],
          touchSessionEntry: false,
        });
        await sessionAccessor.replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          lifecycleRevision: `child-lifecycle-${index}`,
          status: "done",
          updatedAt: Date.now(),
          lastActivityAt: 11,
          lastInteractionAt: 10,
          ...fixture.entry,
        });
        const before = expectDefined(sessionAccessor.loadSessionEntry(scope), fixture.sessionKey);
        expected.set(fixture.sessionKey, {
          ...before,
          ...(fixture.displayName ? { displayName: fixture.displayName } : {}),
        });
      }
      await repair();
      for (const [sessionKey, entry] of expected) {
        expect
          .soft(sessionAccessor.loadSessionEntry({ ...params, sessionKey }), sessionKey)
          .toEqual(entry);
      }
      expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBe(
        "[Subagent Context] Explain this phrase",
      );
    },
    [user("[Subagent Context] Explain this phrase")],
  );
});

it.each(Object.entries(INTERNAL_WAKE_TRANSCRIPT_PROMPTS))(
  "preserves the main session name after a %s wake",
  async (sourceTool, content) => {
    await withSession(
      async (params) => {
        const before = sessionAccessor.loadSessionEntry(params);
        await repair();
        expect(sessionAccessor.loadSessionEntry(params)).toEqual(before);
      },
      [{ role: "user", content, provenance: { kind: "internal_system", sourceTool } }],
      "agent:main:main",
    );
  },
);

const relay = { ...user("Internal relay"), provenance: { kind: "inter_session" } };
const later = user("A later task must not become the title");
it.each([
  ["first user request", [relay, ...messages], true],
  ["oversized prefix", [user(`oversized-title-payload ${"x".repeat(70 * 1024)}`), later], false],
  ["message-limited prefix", [...Array.from({ length: 100 }, () => messages[1]!), later], false],
])("derives a title only from a complete %s", async (_label, transcript, complete) => {
  await withSession(async (params) => {
    const parses = vi.spyOn(JSON, "parse");
    const before = sessionAccessor.loadSessionEntry(params);
    await repair();
    expect(sessionAccessor.loadSessionEntry(params)).toEqual(
      complete ? { ...before, displayName: title } : before,
    );
    if (complete) {
      expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    } else {
      expect(
        parses.mock.calls.filter(([text]) => text.includes("oversized-title-payload")),
      ).toEqual([]);
    }
  }, transcript);
});

it.each([
  ["a manual rename", { label: "Manual title" }],
  ["an incognito session", { incognito: true }],
] satisfies Array<[string, Partial<SessionEntry>]>)(
  "preserves %s during title repair",
  async (_name, mutation) => {
    await withSession(async (params) => {
      await sessionAccessor.patchSessionEntryCore(params, () => mutation);
      await repair();
      expect(sessionAccessor.loadSessionEntry(params)).toMatchObject(mutation);
      expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
    });
  },
);

it("leaves every store unchanged when no session needs a title", async () => {
  await withSession(async () => {
    await withDoctorSqliteMaintenanceLock({
      operation: "session title repair",
      run: async (authority) => {
        // As inside the doctor --fix stop: no connection holds the stores.
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        const root = resolveStateDir(process.env);
        // A read-only open of an unheld store may leave empty sidecars; only a write counts.
        const before = snapshotStoreFiles(root, { ignoreReadSidecars: true });

        const report = await repairLegacySessionTitles({
          cfg,
          env: process.env,
          apply: true,
          authority,
        });

        expect(report).toMatchObject({ found: 0, repaired: 0, scannedStores: 1 });
        expect(
          changedStoreFiles(before, snapshotStoreFiles(root, { ignoreReadSidecars: true })),
        ).toEqual([]);
      },
    });
  }, [{ role: "assistant", content: "A reply with no user request to name the session" }]);
});

it("repairs a title when no connection holds the stores", async () => {
  await withSession(async (params) => {
    const before = sessionAccessor.loadSessionEntry(params);
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    await repair();
    expect(sessionAccessor.loadSessionEntry(params)).toEqual({ ...before, displayName: title });
  });
});

it("does not commit after Doctor maintenance authority expires", async () => {
  await withSession(async (params) => {
    await withDoctorSqliteMaintenanceLock({
      operation: "session title repair",
      run: async (authority) => {
        const patch = sessionAccessor.patchSessionEntryCore;
        vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementationOnce(
          (scope, update, options) => {
            vi.spyOn(authority, "assertCurrent").mockImplementation(() => {
              throw new Error("Doctor maintenance authority expired");
            });
            return patch(scope, update, options);
          },
        );
        await expect(
          repairLegacySessionTitles({ cfg, env: process.env, apply: true, authority }),
        ).rejects.toThrow("Doctor maintenance authority expired");
        expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
      },
    });
  });
});
