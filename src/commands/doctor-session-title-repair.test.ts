import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { maybeGenerateDashboardSessionTitle } from "../gateway/dashboard-session-title.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { repairLegacySessionTitles } from "./doctor-session-title-repair.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
}));
vi.mock("../agents/utility-model.js", () => ({
  resolveUtilityModelRefForAgent: () => undefined,
}));

beforeEach(() => generateConversationLabelWithFallback.mockReset());
afterEach(() => vi.restoreAllMocks());

async function withSession(
  run: (params: {
    agentId: string;
    storePath: string;
    sessionKey: string;
    sessionId: string;
    lifecycleRevision: string;
    sessionEntry: SessionEntry;
  }) => Promise<void>,
  messages: Array<{ role: string; content: string; provenance?: unknown }> = [
    { role: "user", content: "Investigate why the gateway times out" },
    { role: "assistant", content: "**Found** the slow query" },
  ],
) {
  await withOpenClawTestState(
    { scenario: "minimal", label: "doctor-session-title" },
    async (state) => {
      const params = {
        agentId: "main",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
        sessionKey: "agent:main:dashboard:legacy",
        sessionId: "legacy-session",
        lifecycleRevision: "legacy-lifecycle",
      };
      await sessionAccessor.persistSessionTranscriptTurn(params, {
        messages: messages.map((message) => ({ message })),
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
      await run({
        ...params,
        sessionEntry: expectDefined(
          sessionAccessor.loadSessionEntry(params),
          "seeded session entry",
        ),
      });
    },
  );
}

function repair() {
  return noteSessionTranscriptHealth({
    cfg: { agents: { list: [{ id: "main", default: true }] } },
    shouldRepair: true,
    postSessionPluginMigrationPlanBound: true,
  });
}

describe("Doctor session title repair", () => {
  it("uses the first user request and preserves activity without calling a model", async () => {
    await withSession(
      async (params) => {
        const before = sessionAccessor.loadSessionEntry(params);
        await repair();
        expect(sessionAccessor.loadSessionEntry(params)).toEqual({
          ...before,
          displayName: "Investigate why the gateway times out",
        });
        expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
      },
      [
        { role: "user", content: "Internal relay", provenance: { kind: "inter_session" } },
        { role: "user", content: "Investigate why the gateway times out" },
        { role: "assistant", content: "**Found** the slow query" },
      ],
    );
  });

  it.each(["oversized prefix", "user request after the first 100 messages"])(
    "does not name a session from an incomplete %s",
    async (kind) => {
      const messages =
        kind === "oversized prefix"
          ? [{ role: "user", content: `oversized-title-payload ${"x".repeat(70 * 1024)}` }]
          : Array.from({ length: 100 }, () => ({ role: "assistant", content: "Earlier reply" }));
      await withSession(
        async (params) => {
          const parse = JSON.parse;
          let oversizedParses = 0;
          vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (text.includes("oversized-title-payload")) {
              oversizedParses++;
            }
            return parse(text, reviver);
          });
          const before = sessionAccessor.loadSessionEntry(params);
          await repair();
          expect(sessionAccessor.loadSessionEntry(params)).toEqual(before);
          expect(oversizedParses).toBe(0);
        },
        [...messages, { role: "user", content: "A later task must not become the title" }],
      );
    },
  );

  it.each([
    ["a replacement lifecycle", { lifecycleRevision: "replacement" }],
    ["a manual rename", { label: "Manual title" }],
    ["a newly running turn", { status: "running" }],
  ] satisfies Array<[string, Partial<SessionEntry>]>)(
    "preserves %s admitted before its metadata write",
    async (_name, mutation) => {
      await withSession(async (params) => {
        const patch = sessionAccessor.patchSessionEntryCore;
        vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementationOnce(
          async (scope, update, options) => {
            await patch(scope, () => mutation);
            return patch(scope, update, options);
          },
        );
        await repair();
        expect(sessionAccessor.loadSessionEntry(params)).toMatchObject(mutation);
        expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
      });
    },
  );

  it("rejects a title from a transcript rewritten before its metadata commit", async () => {
    await withSession(async (params) => {
      const patch = sessionAccessor.patchSessionEntryCore;
      vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementationOnce(
        async (scope, update, options) => {
          await sessionAccessor.replaceTranscriptEvents(params, [
            { type: "session", version: 3, id: params.sessionId },
            {
              type: "message",
              id: "replacement-user",
              parentId: null,
              message: { role: "user", content: "A different branch" },
            },
          ]);
          return patch(scope, update, options);
        },
      );
      await repair();
      expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
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
            repairLegacySessionTitles({
              cfg: { agents: { list: [{ id: "main", default: true }] } },
              env: process.env,
              apply: true,
              authority,
            }),
          ).rejects.toThrow("Doctor maintenance authority expired");
          expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
        },
      });
    });
  });

  it("lets an in-flight foreground title request keep its naming decision", async () => {
    await withSession(async (params) => {
      const started = createDeferredCore();
      const title = createDeferredCore<string>();
      generateConversationLabelWithFallback.mockImplementation(() => {
        started.resolve();
        return title.promise;
      });
      const foreground = maybeGenerateDashboardSessionTitle({
        ...params,
        cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
        entry: sessionAccessor.loadSessionEntry(params),
        userMessage: "Investigate why the gateway times out",
      });
      await started.promise;
      try {
        await repair();
      } finally {
        title.resolve("Model-generated title");
        await foreground;
      }
      expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBe("Model-generated title");
      expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
    });
  });
});
