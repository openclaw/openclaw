/**
 * Tests fresh child state in exact session-row Gateway projections.
 */
import { existsSync } from "node:fs";
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
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
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

type SingleRowCacheContext = {
  now: number;
  storePath: string;
};

type MovingChildFixture = {
  oldParent: string;
  newParent: string;
  child: string;
  store: Record<string, SessionEntry>;
};

async function withSingleRowCacheStore(
  statePrefix: string,
  workspace: string,
  run: (context: SingleRowCacheContext) => Promise<void>,
): Promise<void> {
  await withStateDirEnv(statePrefix, async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: MAIN_AGENT_ID,
            default: true,
            workspace,
          },
        ],
        defaults: { model: { primary: TEST_MODEL } },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    await run({
      now: Math.floor(Date.now() / 1_000) * 1_000 + 100,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: MAIN_AGENT_ID }),
    });
  });
}

function parentSession(sessionId: string, now: number): SessionEntry {
  return {
    sessionId,
    updatedAt: now,
  };
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

function runningControlledChildSession(
  sessionId: string,
  spawnedBy: string,
  now: number,
  parentSessionKey?: string,
): SessionEntry {
  return {
    sessionId,
    spawnedBy,
    ...(parentSessionKey ? { parentSessionKey } : {}),
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

function createMovingChildFixture(now: number): MovingChildFixture {
  const oldParent = "agent:main:subagent:parent-old";
  const newParent = "agent:main:subagent:parent-new";
  const child = "agent:main:subagent:child";
  return {
    oldParent,
    newParent,
    child,
    store: {
      [oldParent]: parentSession("parent-old", now),
      [newParent]: parentSession("parent-new", now),
      [child]: runningChildSession("child", oldParent, now),
    },
  };
}

async function expectChildMovedToNewParent(
  fixture: MovingChildFixture,
  now: number,
): Promise<void> {
  expect(
    (await rowReader.row(fixture.oldParent, { now: now + 50 }))?.childSessions,
  ).toBeUndefined();
  expect((await rowReader.row(fixture.newParent, { now: now + 50 }))?.childSessions).toEqual([
    fixture.child,
  ]);
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

  test.each([undefined, false])(
    "reads only the selected session while preserving projections and hidden effects (clone: %s)",
    async (clone) => {
      await withSingleRowCacheStore(
        "openclaw-single-row-hidden-effects-",
        "/tmp/openclaw-single-row-hidden-effects",
        async ({ now, storePath }) => {
          const hidden = resolveInternalSessionEffectsIdentity({
            agentId: MAIN_AGENT_ID,
            runId: "suppressed-effects",
          });
          const sessionKey = "agent:main:main";
          const visible: SessionEntry = {
            ...parentSession("visible-session", now),
            skillsSnapshot: { prompt: "saved skill prompt", skills: [] },
            systemPromptReport: {
              source: "run",
              generatedAt: now,
              systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
              injectedWorkspaceFiles: [],
              skills: { promptChars: 0, entries: [] },
              tools: { listChars: 0, schemaChars: 0, entries: [] },
            },
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
        },
      );
    },
  );

  test("preserves missing-store behavior for borrowed and owned entry lookups", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-missing-store-",
      "/tmp/openclaw-single-row-missing-store",
      async ({ now }) => {
        const databasePath = resolveOpenClawAgentSqlitePath({ agentId: MAIN_AGENT_ID });
        const missing = loadSessionEntry("main", { clone: false });
        expect(missing.entry).toBeUndefined();
        expect(existsSync(databasePath)).toBe(false);
        expect(loadSessionEntry("main").entry).toBeUndefined();
        expect(existsSync(databasePath)).toBe(true);
        expect(await rowReader.row(missing.canonicalKey, { now })).toBeNull();
      },
    );
  });

  test("keeps warm child snapshots current and response mutations isolated", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-",
      "/tmp/openclaw-single-row-cache",
      async ({ now, storePath }) => {
        const store: Record<string, SessionEntry> = {
          "agent:main:subagent:parent-a": {
            ...parentSession("parent-a", now),
            skillsSnapshot: { prompt: "parent saved skill prompt", skills: [] },
            systemPromptReport: {
              source: "run",
              generatedAt: now,
              systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
              injectedWorkspaceFiles: [],
              skills: { promptChars: 0, entries: [] },
              tools: { listChars: 0, schemaChars: 0, entries: [] },
            },
            toolOverrides: { mcpToolsDeny: { synthetic: ["blocked"] } },
          },
          "agent:main:subagent:child-a": {
            ...runningChildSession("child-a", "agent:main:subagent:parent-a", now),
            skillsSnapshot: { prompt: "child saved skill prompt", skills: [] },
          },
          "agent:main:subagent:parent-b": parentSession("parent-b", now),
          "agent:main:subagent:child-b": runningChildSession(
            "child-b",
            "agent:main:subagent:parent-b",
            now,
          ),
        };
        await seedSessionEntries(storePath, store);

        const rowA = await rowReader.row("agent:main:subagent:parent-a", { now });
        const rowB = await rowReader.row("agent:main:subagent:parent-b", { now: now + 50 });
        const rowAAfterWindow = await rowReader.row("agent:main:subagent:parent-a", {
          now: now + 1_500,
        });

        expect(rowA?.childSessions).toEqual(["agent:main:subagent:child-a"]);
        expect(rowB?.childSessions).toEqual(["agent:main:subagent:child-b"]);
        expect(rowAAfterWindow?.childSessions).toEqual(["agent:main:subagent:child-a"]);
        for (let index = 0; index < 2; index += 1) {
          const loaded = loadGatewaySessionEntryReadOnly("agent:main:subagent:parent-a", {
            clone: false,
            includeStoreChildEntries: true,
            projection: "list",
          });
          expect(loaded.store["agent:main:subagent:child-a"]?.skillsSnapshot).toBeUndefined();
          {
            const row = await rowReader.row(loaded.canonicalKey, { now });
            expect(row?.childSessions).toEqual(["agent:main:subagent:child-a"]);
            const parse = vi.spyOn(JSON, "parse");
            try {
              const lifecycle = await rowReader.snapshot("agent:main:subagent:parent-a", { now });
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
              expect(
                (await rowReader.snapshot("agent:main:subagent:parent-a", { now })).row,
              ).toEqual(row);
            } finally {
              parse.mockRestore();
            }
          }
        }
        await updateSessionEntry({ sessionKey: "agent:main:subagent:parent-a", storePath }, () => ({
          label: "fresh lifecycle label",
          updatedAt: now + 1,
        }));
        await updateSessionEntry({ sessionKey: "agent:main:subagent:child-a", storePath }, () => ({
          parentSessionKey: "agent:main:subagent:parent-b",
          updatedAt: now + 1,
        }));
        const fresh = await rowReader.snapshot("agent:main:subagent:parent-a", { now });
        expect(fresh.row?.label).toBe("fresh lifecycle label");
        expect(fresh.row?.childSessions).toBeUndefined();
        expect(rowA?.label).toBeUndefined();
        expect(rowA?.childSessions).toEqual(["agent:main:subagent:child-a"]);
      },
    );
  });

  test("refreshes resident child rows after subagent registry publication", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-fresh-registry-",
      "/tmp/openclaw-single-row-cache-fresh-registry",
      async ({ now, storePath }) => {
        const fixture = createMovingChildFixture(now);
        // This fixture moves runtime control only; an explicit parent would
        // instead declare durable navigation lineage that must remain linked.
        fixture.store[fixture.child] = runningControlledChildSession(
          "child",
          fixture.oldParent,
          now,
        );
        await seedSessionEntries(storePath, fixture.store);

        setSubagentControllerRun(fixture.child, fixture.oldParent, now);
        expect((await rowReader.row(fixture.oldParent, { now }))?.childSessions).toEqual([
          fixture.child,
        ]);

        setSubagentControllerRun(fixture.child, fixture.newParent, now + 25);
        await expectChildMovedToNewParent(fixture, now);
      },
    );
  });

  test("keeps independent navigation lineage while runtime control moves", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-navigation-owner-",
      "/tmp/openclaw-single-row-cache-navigation-owner",
      async ({ now, storePath }) => {
        const fixture = createMovingChildFixture(now);
        const navigationParent = "agent:main:dashboard:navigation-parent";
        fixture.store[navigationParent] = parentSession("navigation-parent", now);
        fixture.store[fixture.child] = runningControlledChildSession(
          "child",
          fixture.oldParent,
          now,
          navigationParent,
        );
        await seedSessionEntries(storePath, fixture.store);

        setSubagentControllerRun(fixture.child, fixture.oldParent, now);
        expect((await rowReader.row(navigationParent, { now }))?.childSessions).toEqual([
          fixture.child,
        ]);

        setSubagentControllerRun(fixture.child, fixture.newParent, now + 25);
        expect((await rowReader.row(navigationParent, { now: now + 50 }))?.childSessions).toEqual([
          fixture.child,
        ]);
        await expectChildMovedToNewParent(fixture, now);
      },
    );
  });

  test.each(["main", "worker"])(
    "removes deleted runtime-only children from exact rows (%s)",
    async (agentId) => {
      await withSingleRowCacheStore(
        "openclaw-canonical-child-",
        "/tmp/openclaw-canonical-child",
        async ({ now, storePath }) => {
          const parentKey = "agent:main:parent";
          const childKey = `agent:${agentId}:subagent:child`;
          const childStorePath = resolveSessionStorePathCore(undefined, { agentId });
          await seedSessionEntries(storePath, { [parentKey]: parentSession("parent", now) });
          await replaceSessionEntry(
            { agentId, storePath: childStorePath, sessionKey: childKey },
            {
              sessionId: "child",
              updatedAt: now,
            },
          );
          setSubagentControllerRun(childKey, parentKey, now);
          expect((await rowReader.row(parentKey, { now }))?.childSessions).toEqual([childKey]);

          await deleteSessionEntryLifecycle({
            agentId,
            storePath: childStorePath,
            archiveTranscript: false,
            target: { canonicalKey: childKey, storeKeys: [childKey] },
          });
          expect((await rowReader.row(parentKey, { now }))?.childSessions).toBeUndefined();
        },
      );
    },
  );

  test("refreshes store child candidates after session writes", async () => {
    await withSingleRowCacheStore(
      "openclaw-single-row-cache-write-version-",
      "/tmp/openclaw-single-row-cache-write-version",
      async ({ now, storePath }) => {
        const fixture = createMovingChildFixture(now);
        await seedSessionEntries(storePath, fixture.store);

        expect((await rowReader.row(fixture.oldParent, { now }))?.childSessions).toEqual([
          fixture.child,
        ]);
        await updateSessionEntry({ sessionKey: fixture.child, storePath }, () => ({
          parentSessionKey: fixture.newParent,
          updatedAt: now + 25,
        }));

        await expectChildMovedToNewParent(fixture, now);
      },
    );
  });
});
