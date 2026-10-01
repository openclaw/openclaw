/**
 * Tests fresh child state in exact session-row Gateway projections.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import {
  deleteSessionEntryLifecycle,
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";

const rowReader = createResidentSessionRowReader();
async function withStateDirEnv<T>(
  prefix: string,
  fn: (context: { tempRoot: string; stateDir: string }) => Promise<T>,
) {
  return withRawStateDirEnv(prefix, async (context) => {
    try {
      return await fn(context);
    } finally {
      await rowReader.dispose();
    }
  });
}

import { loadGatewaySessionEntryReadOnly, loadSessionEntry } from "./session-utils.js";

const MAIN_AGENT_ID = "main";
const TEST_MODEL = "openai/gpt-5.4";

async function withSingleRowCacheStore(
  run: (context: { now: number; storePath: string }) => Promise<void>,
): Promise<void> {
  await withStateDirEnv("openclaw-single-row-", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: MAIN_AGENT_ID, default: true, workspace: "/tmp/openclaw-single-row" }],
        defaults: { model: { primary: TEST_MODEL } },
      },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    await run({
      now: Math.floor(Date.now() / 1_000) * 1_000 + 100,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: MAIN_AGENT_ID }),
    });
  });
}

function retainedDetails(
  now: number,
  prompt: string,
): Pick<SessionEntry, "skillsSnapshot" | "systemPromptReport"> {
  return {
    skillsSnapshot: { prompt, skills: [] },
    systemPromptReport: {
      source: "run",
      generatedAt: now,
      systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: prompt.length, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    },
  };
}

function parentSession(sessionId: string, now: number): SessionEntry {
  return { sessionId, updatedAt: now };
}

function runningChildSession(
  sessionId: string,
  parentSessionKey: string,
  now: number,
): SessionEntry {
  return {
    sessionId,
    parentSessionKey,
    updatedAt: now,
    status: "running",
  };
}

async function seedSessionEntries(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(store)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
}

function setSubagentControllerRun(
  childSessionKey: string,
  controllerSessionKey: string,
  createdAt: number,
): void {
  addSubagentRunForTests({
    runId: childSessionKey,
    childSessionKey,
    controllerSessionKey,
    requesterSessionKey: controllerSessionKey,
    requesterDisplayKey: controllerSessionKey,
    task: "Synthetic child",
    cleanup: "keep",
    createdAt,
    startedAt: createdAt,
  });
  subagentRuns.commitOwnership(subagentRuns.get(childSessionKey)!);
}

describe("single gateway session row child projections", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
    resetSubagentRegistryForTests({ persist: false });
    vi.clearAllMocks();
  });

  test("retains the loaded owner after a qualified main alias becomes global", async () => {
    await withStateDirEnv("openclaw-single-row-global-owner-", async () => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: {
          entries: {
            main: { default: true, model: { primary: "openai/gpt-5.4" } },
            research: { model: { primary: "openai/gpt-5.5" } },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      await replaceSessionEntry(
        { agentId: "research", sessionKey: "global" },
        { sessionId: "research-main", updatedAt: 42 },
      );
      const key = "agent:research:main";
      expect(loadGatewaySessionEntryReadOnly(key)).toMatchObject({
        agentId: "research",
        canonicalKey: "global",
        entry: { sessionId: "research-main" },
      });
      expect.soft((await rowReader.snapshot(key)).row).toMatchObject({
        key: "global",
        sessionId: "research-main",
        agentId: "research",
        model: "gpt-5.5",
      });
      expect(await rowReader.row(key, { agentId: "research" })).toMatchObject({
        key: "global",
        agentId: "research",
        model: "gpt-5.5",
      });
    });
  });

  test.each([false])(
    "reads only the selected session while preserving projections and hidden effects (clone: %s)",
    async (clone) => {
      await withSingleRowCacheStore(async ({ now, storePath }) => {
        const hidden = resolveInternalSessionEffectsIdentity({
          agentId: MAIN_AGENT_ID,
          runId: "suppressed-effects",
        });
        const sessionKey = "agent:main:main";
        const visible: SessionEntry = {
          ...parentSession("visible-session", now),
          ...retainedDetails(now, "saved skill prompt"),
        };
        await seedSessionEntries(storePath, {
          [sessionKey]: visible,
          [hidden.sessionKey]: parentSession(hidden.sessionId, now),
          ...Object.fromEntries(
            Array.from({ length: 24 }, (_, index) => [
              `agent:main:unrelated-${index}`,
              { ...visible, sessionId: `unrelated-session-${index}` },
            ]),
          ),
        });

        // The canonical store scan belongs to handle admission, before repeated row lookups.
        expect(loadExactSessionEntryReadOnly({ sessionKey, storePath })?.entry.sessionId).toBe(
          visible.sessionId,
        );
        const parse = vi.spyOn(JSON, "parse");
        try {
          const metadata = loadSessionEntry("main", {
            agentId: MAIN_AGENT_ID,
            clone,
            projection: "list",
          });
          expect(metadata).toMatchObject({
            agentId: MAIN_AGENT_ID,
            canonicalKey: sessionKey,
            storePath,
            entry: parentSession(visible.sessionId, now),
          });
          expect(metadata.entry?.skillsSnapshot).toBeUndefined();
          expect(metadata.entry?.systemPromptReport).toBeUndefined();
          expect(parse.mock.calls.some(([value]) => value.includes("saved skill prompt"))).toBe(
            false,
          );
          expect(loadSessionEntry("main", { agentId: MAIN_AGENT_ID, clone })).toMatchObject({
            agentId: metadata.agentId,
            canonicalKey: metadata.canonicalKey,
            storePath: metadata.storePath,
            entry: visible,
          });

          expect(loadSessionEntry(hidden.sessionKey, { clone }).entry).toBeUndefined();
          expect(
            loadSessionEntry(hidden.sessionKey, { clone, projection: "list" }).entry,
          ).toBeUndefined();
          expect(loadGatewaySessionEntryReadOnly(hidden.sessionKey).entry?.sessionId).toBe(
            hidden.sessionId,
          );
          expect(loadExactSessionEntryReadOnly({ ...hidden, storePath })?.entry.sessionId).toBe(
            hidden.sessionId,
          );
          expect(
            parse.mock.calls.filter(
              ([value]) => typeof value === "string" && value.includes("unrelated-session-"),
            ),
          ).toHaveLength(0);
        } finally {
          parse.mockRestore();
        }
      });
    },
  );

  test("keeps warm child snapshots current and response mutations isolated", async () => {
    await withSingleRowCacheStore(async ({ now, storePath }) => {
      const parentA = "agent:main:subagent:parent-a";
      const parentB = "agent:main:subagent:parent-b";
      const childA = "agent:main:subagent:child-a";
      const childB = "agent:main:subagent:child-b";
      const store: Record<string, SessionEntry> = {
        [parentA]: {
          ...parentSession("parent-a", now),
          ...retainedDetails(now, "parent saved skill prompt"),
          toolOverrides: { mcpToolsDeny: { synthetic: ["blocked"] } },
        },
        [childA]: {
          ...runningChildSession("child-a", parentA, now),
          ...retainedDetails(now, "child saved skill prompt"),
          systemPromptReport: {
            ...retainedDetails(now, "child saved skill prompt").systemPromptReport!,
            tools: {
              listChars: 0,
              schemaChars: 1,
              entries: [{ name: "child saved report", summaryChars: 0, schemaChars: 1 }],
            },
          },
        },
        [parentB]: parentSession("parent-b", now),
        [childB]: runningChildSession("child-b", parentB, now),
      };
      await seedSessionEntries(storePath, store);

      const rowA = await rowReader.row(parentA, { now });
      const rowB = await rowReader.row(parentB, { now: now + 50 });
      const rowAAfterWindow = await rowReader.row(parentA, {
        now: now + 1_500,
      });

      expect(rowA?.childSessions).toEqual([childA]);
      expect(rowB?.childSessions).toEqual([childB]);
      expect(rowAAfterWindow?.childSessions).toEqual([childA]);
      for (const projection of [undefined, "list"] as const) {
        const parse = vi.spyOn(JSON, "parse");
        try {
          const loaded = loadGatewaySessionEntryReadOnly(parentA, {
            clone: false,
            includeStoreChildEntries: true,
            projection,
          });
          if (projection === undefined) {
            expect(loaded.entry?.skillsSnapshot).toEqual({
              prompt: "parent saved skill prompt",
              skills: [],
            });
            expect(loaded.entry?.systemPromptReport).toMatchObject({
              source: "run",
              generatedAt: now,
            });
          }
          expect(loaded.store[childA]).toMatchObject({
            sessionId: "child-a",
            parentSessionKey: parentA,
            status: "running",
          });
          expect(loaded.store[childA]?.skillsSnapshot).toBeUndefined();
          expect(loaded.store[childA]?.systemPromptReport).toBeUndefined();
          expect(
            parse.mock.calls.some(
              ([value]) =>
                value.includes("child saved skill prompt") || value.includes("child saved report"),
            ),
          ).toBe(false);
          const row = await rowReader.row(loaded.canonicalKey, { now });
          expect(row?.childSessions).toEqual([childA]);
          parse.mockClear();
          const lifecycle = await rowReader.snapshot(parentA, { now });
          expect(lifecycle.row).toEqual(row);
          expect(
            parse.mock.calls.some(
              ([value]) =>
                value.includes("saved skill prompt") || value.includes('"systemPromptReport"'),
            ),
          ).toBe(false);
          const denied = lifecycle.row?.toolOverrides?.mcpToolsDeny?.synthetic;
          if (!denied) {
            throw new Error("expected lifecycle tool overrides");
          }
          denied.push("response-only");
          expect((await rowReader.snapshot(parentA, { now })).row).toEqual(row);
        } finally {
          parse.mockRestore();
        }
      }
      await updateSessionEntry({ sessionKey: parentA, storePath }, () => ({
        label: "fresh lifecycle label",
        updatedAt: now + 1,
      }));
      await updateSessionEntry({ sessionKey: childA, storePath }, () => ({
        parentSessionKey: parentB,
        updatedAt: now + 1,
      }));
      const fresh = await rowReader.snapshot(parentA, { now });
      expect(fresh.row?.label).toBe("fresh lifecycle label");
      expect(fresh.row?.childSessions).toBeUndefined();
      expect(rowA?.label).toBeUndefined();
      expect(rowA?.childSessions).toEqual([childA]);
    });
  });

  test("keeps independent navigation lineage while runtime control moves", async () => {
    await withSingleRowCacheStore(async ({ now, storePath }) => {
      const oldParent = "agent:main:subagent:old-parent";
      const newParent = "agent:main:subagent:new-parent";
      const child = "agent:main:subagent:child";
      const navigation = "agent:main:dashboard:navigation";
      await seedSessionEntries(storePath, {
        [oldParent]: parentSession("old-parent", now),
        [newParent]: parentSession("new-parent", now),
        [navigation]: parentSession("navigation", now),
        [child]: { ...runningChildSession("child", navigation, now), spawnedBy: oldParent },
      });
      setSubagentControllerRun(child, oldParent, now);
      expect((await rowReader.row(navigation, { now }))?.childSessions).toEqual([child]);
      setSubagentControllerRun(child, newParent, now + 25);
      expect((await rowReader.row(navigation, { now: now + 50 }))?.childSessions).toEqual([child]);
      expect((await rowReader.row(oldParent, { now: now + 50 }))?.childSessions).toBeUndefined();
      expect((await rowReader.row(newParent, { now: now + 50 }))?.childSessions).toEqual([child]);
    });
  });

  test.each(["worker"])(
    "keeps runtime-only child reads compact and removes deleted children (%s)",
    async (agentId) => {
      await withSingleRowCacheStore(async ({ now, storePath }) => {
        const parentKey = "agent:main:parent";
        const childKey = `agent:${agentId}:subagent:child`;
        const childStorePath = resolveSessionStorePathCore(undefined, { agentId });
        const childPrompt = "unused registry child prompt ".repeat(2048);
        await seedSessionEntries(storePath, { [parentKey]: parentSession("parent", now) });
        await replaceSessionEntry(
          { agentId, storePath: childStorePath, sessionKey: childKey },
          {
            sessionId: "child",
            updatedAt: now,
            ...retainedDetails(now, childPrompt),
          },
        );
        setSubagentControllerRun(childKey, parentKey, now);
        const parsed = vi.spyOn(JSON, "parse");
        try {
          const loaded = loadGatewaySessionEntryReadOnly(parentKey, {
            includeStoreChildEntries: true,
          });
          expect(loaded.store[childKey]).toMatchObject({ sessionId: "child", updatedAt: now });
          expect(loaded.store[childKey]?.skillsSnapshot).toBeUndefined();
          expect(loaded.store[childKey]?.systemPromptReport).toBeUndefined();
          expect(
            parsed.mock.calls.some(
              ([value]) => value.includes(childPrompt) || value.includes('"systemPromptReport"'),
            ),
          ).toBe(false);
        } finally {
          parsed.mockRestore();
        }
        expect((await rowReader.row(parentKey, { now }))?.childSessions).toEqual([childKey]);

        await deleteSessionEntryLifecycle({
          agentId,
          storePath: childStorePath,
          archiveTranscript: false,
          target: { canonicalKey: childKey, storeKeys: [childKey] },
        });
        expect(
          loadGatewaySessionEntryReadOnly(parentKey, { includeStoreChildEntries: true }).store[
            childKey
          ],
        ).toBeUndefined();
        expect((await rowReader.row(parentKey, { now }))?.childSessions).toBeUndefined();
      });
    },
  );
});
