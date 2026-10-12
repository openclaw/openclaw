import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSubagentTaskMessage } from "../agents/subagents/spawn/subagent-system-prompt.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { repairLegacySessionTitles } from "./doctor-session-title-repair.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
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
    cfg: { agents: { entries: { main: {} } } },
    shouldRepair: true,
    postSessionPluginMigrationPlanBound: true,
  });
}

describe("Doctor session title repair", () => {
  it("preserves spawn-owned names while repairing ordinary sessions in the same scan", async () => {
    await withSession(
      async (params) => {
        const task = "Reply only with 17 * 19. Do not use tools.";
        const fixtures = [
          ...(["run", "session"] as const).flatMap((spawnMode) => {
            const historical = [
              "[Subagent Context] You are running as a subagent (depth 1/5). Complete the current [Subagent Task]; inherited conversation is background context, not your assignment.",
              ...(spawnMode === "session"
                ? [
                    "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages.",
                  ]
                : []),
              "[Subagent Task]",
              task,
              "Begin. Execute the assigned task to completion.",
            ].join("\n\n");
            return [
              historical,
              buildSubagentTaskMessage({ task, spawnMode, childDepth: 1, maxSpawnDepth: 5 }),
            ].map((message, index) => ({
              sessionKey: `agent:main:subagent:${spawnMode}-child-${index}`,
              message,
              entry: { spawnedBy: params.sessionKey },
              displayName: undefined,
            }));
          }),
          {
            sessionKey: "agent:main:dashboard:visible-child",
            entry: { spawnedBy: params.sessionKey },
            message: "Investigate the slow query",
            displayName: "Investigate the slow query",
          },
          {
            sessionKey: "agent:main:subagent:named-child",
            entry: { label: "Query analysis", spawnedBy: params.sessionKey },
            message: task,
            displayName: undefined,
          },
        ];
        const expected = new Map<string, SessionEntry>([
          [
            params.sessionKey,
            { ...params.sessionEntry, displayName: "[Subagent Context] Explain this phrase" },
          ],
        ]);
        for (const [index, fixture] of fixtures.entries()) {
          const scope = {
            agentId: params.agentId,
            storePath: params.storePath,
            sessionKey: fixture.sessionKey,
            sessionId: `child-${index}`,
          };
          await sessionAccessor.persistSessionTranscriptTurn(scope, {
            messages: [{ message: { role: "user", content: fixture.message } }],
            touchSessionEntry: false,
          });
          await sessionAccessor.replaceSessionEntry(scope, {
            ...params.sessionEntry,
            sessionId: scope.sessionId,
            lifecycleRevision: `child-lifecycle-${index}`,
            // Keep fixture children outside automatic age-based reclamation while seeding siblings.
            updatedAt: Date.now(),
            ...fixture.entry,
          });
          const before = expectDefined(
            sessionAccessor.loadSessionEntry(scope),
            "seeded child entry",
          );
          expected.set(scope.sessionKey, {
            ...before,
            ...(fixture.displayName ? { displayName: fixture.displayName } : {}),
          });
        }
        for (const sessionKey of expected.keys()) {
          expect(
            sessionAccessor.loadSessionEntry({ ...params, sessionKey }),
            sessionKey,
          ).toBeDefined();
        }
        await repair();
        for (const [sessionKey, entry] of expected) {
          expect
            .soft(sessionAccessor.loadSessionEntry({ ...params, sessionKey }), sessionKey)
            .toEqual(entry);
        }
      },
      [{ role: "user", content: "[Subagent Context] Explain this phrase" }],
    );
  });

  it.each(["first user request", "oversized prefix", "user request after the first 100 messages"])(
    "derives a title only from a complete %s",
    async (kind) => {
      const complete = kind === "first user request";
      const messages = complete
        ? [
            { role: "user", content: "Internal relay", provenance: { kind: "inter_session" } },
            { role: "user", content: "Investigate why the gateway times out" },
            { role: "assistant", content: "**Found** the slow query" },
          ]
        : [
            ...(kind === "oversized prefix"
              ? [{ role: "user", content: `oversized-title-payload ${"x".repeat(70 * 1024)}` }]
              : Array.from({ length: 100 }, () => ({
                  role: "assistant",
                  content: "Earlier reply",
                }))),
            { role: "user", content: "A later task must not become the title" },
          ];
      await withSession(async (params) => {
        let oversizedParses = 0;
        if (!complete) {
          const parse = JSON.parse;
          vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (text.includes("oversized-title-payload")) {
              oversizedParses++;
            }
            return parse(text, reviver);
          });
        }
        const before = sessionAccessor.loadSessionEntry(params);
        await repair();
        expect(sessionAccessor.loadSessionEntry(params)).toEqual(
          complete ? { ...before, displayName: "Investigate why the gateway times out" } : before,
        );
        if (complete) {
          expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
        } else {
          expect(oversizedParses).toBe(0);
        }
      }, messages);
    },
  );

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
            repairLegacySessionTitles({
              cfg: { agents: { entries: { main: {} } } },
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
});
