import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
