import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as registry from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import * as config from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { loadSessionEntryAsync as loadEntry } from "./session-entry-load.test-support.js";
import { holdSubagentExecution } from "./session-row-projection.read-fixture.test-support.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnlyAsync as loadGatewayEntry } from "./session-utils.js";

const MAIN_AGENT_ID = "main";
const rowReader = createResidentSessionRowReader();
const modelAgent = (primary = "openai/gpt-5.4") => ({ model: { primary } });

function withStore(
  run: (context: { now: number; storePath: string }) => Promise<void>,
  cfg: OpenClawConfig = {
    agents: {
      entries: { [MAIN_AGENT_ID]: { workspace: "/tmp/openclaw-single-row" } },
      defaults: modelAgent(),
    },
  },
) {
  return () =>
    withStateDirEnv("openclaw-single-row-", async () => {
      config.setRuntimeConfigSnapshot(cfg, cfg);
      try {
        await run({
          now: Math.floor(Date.now() / 1_000) * 1_000 + 100,
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: MAIN_AGENT_ID }),
        });
      } finally {
        await rowReader.dispose();
      }
    });
}

function retainedDetails(now: number, prompt: string, reportName?: string) {
  const entries = reportName ? [{ name: reportName, summaryChars: 0, schemaChars: 1 }] : [];
  return {
    skillsSnapshot: { prompt, skills: [] },
    systemPromptReport: {
      source: "run" as const,
      generatedAt: now,
      systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: prompt.length, entries: [] },
      tools: { listChars: 0, schemaChars: entries.length, entries },
    },
  };
}

function session(sessionId: string, now: number, parentSessionKey?: string): SessionEntry {
  return { sessionId, updatedAt: now, ...(parentSessionKey && { parentSessionKey }) };
}

const children = async (key: string, now: number) => {
  const projection = await rowReader.ready();
  const query = { key, agentId: MAIN_AGENT_ID };
  return projection.withPreparedExactRows(
    () => [query],
    (read) => {
      const row = read.describe(query);
      return row ? read.present(row, { now }).childSessions : undefined;
    },
  );
};
const loadChildren = (key: string, projection?: "list") =>
  loadGatewaySessionEntryReadOnlyInWorker({
    cfg: config.getRuntimeConfig(),
    key,
    includeStoreChildEntries: true,
    projection,
  });

function expectUnparsed(parse: MockInstance<typeof JSON.parse>, ...fragments: string[]) {
  expect(
    parse.mock.calls.some(([value]) => fragments.some((fragment) => value.includes(fragment))),
  ).toBe(false);
}

function expectCompact(entry: SessionEntry | undefined) {
  expect([entry?.skillsSnapshot, entry?.systemPromptReport]).toEqual([undefined, undefined]);
}

async function withParseSpy(run: (parse: MockInstance<typeof JSON.parse>) => Promise<void>) {
  const parse = vi.spyOn(JSON, "parse");
  await run(parse).finally(() => parse.mockRestore());
}

async function seed(storePath: string, store: Record<string, SessionEntry>) {
  for (const [sessionKey, entry] of Object.entries(store)) {
    await sessions.replaceSessionEntry({ sessionKey, storePath }, entry);
  }
}

async function control(childSessionKey: string, controllerSessionKey: string, createdAt: number) {
  await registry.addSubagentRunForTests({
    runId: childSessionKey,
    childSessionKey,
    controllerSessionKey,
    requesterSessionKey: controllerSessionKey,
    createdAt,
    startedAt: createdAt,
  });
  const execution = holdSubagentExecution(childSessionKey, childSessionKey);
  subagentRuns.commitOwnership(subagentRuns.get(childSessionKey)!);
  return execution;
}

afterEach(async () => {
  config.resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  await registry.resetSubagentRegistryForTests({ persist: false });
  vi.clearAllMocks();
});

test(
  "retains global alias ownership",
  withStore(
    async () => {
      await sessions.replaceSessionEntry(
        { agentId: "research", sessionKey: "global" },
        { sessionId: "research-main", updatedAt: 42 },
      );
      const key = "agent:research:main";
      expect(await loadGatewayEntry(key)).toMatchObject({
        agentId: "research",
        canonicalKey: "global",
        entry: { sessionId: "research-main" },
      });
      const expected = { key: "global", agentId: "research", model: "gpt-5.5" };
      expect.soft((await rowReader.snapshot(key)).row).toMatchObject({
        ...expected,
        sessionId: "research-main",
      });
      expect(await rowReader.row(key, { agentId: "research" })).toMatchObject(expected);
    },
    {
      session: { scope: "global" },
      agents: { entries: { main: modelAgent(), research: modelAgent("openai/gpt-5.5") } },
    },
  ),
);

test(
  "loads selected rows without hidden effects or eager parsing",
  withStore(async ({ now, storePath }) => {
    const load = (key: string, projection?: "list", agentId?: string) =>
      loadEntry(key, { agentId, clone: false, projection });
    const hidden = resolveInternalSessionEffectsIdentity({
      agentId: MAIN_AGENT_ID,
      runId: "suppressed-effects",
    });
    const sessionKey = "agent:main:main";
    const visible: SessionEntry = {
      ...session("visible-session", now),
      ...retainedDetails(now, "saved skill prompt"),
    };
    await seed(storePath, {
      [sessionKey]: visible,
      [hidden.sessionKey]: session(hidden.sessionId, now),
      ...Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => [
          `agent:main:unrelated-${index}`,
          { ...visible, sessionId: `unrelated-session-${index}` },
        ]),
      ),
    });

    expect(sessions.loadExactSessionEntryReadOnly({ sessionKey, storePath })?.entry.sessionId).toBe(
      visible.sessionId,
    );
    await withParseSpy(async (parse) => {
      const metadata = await load("main", "list", MAIN_AGENT_ID);
      const identity = { agentId: MAIN_AGENT_ID, canonicalKey: sessionKey, storePath };
      expect(metadata).toMatchObject({
        ...identity,
        entry: session(visible.sessionId, now),
      });
      expectCompact(metadata.entry);
      expectUnparsed(parse, "saved skill prompt");
      expect(await load("main", undefined, MAIN_AGENT_ID)).toMatchObject({
        ...identity,
        entry: visible,
      });

      expect((await load(hidden.sessionKey)).entry).toBeUndefined();
      expect((await load(hidden.sessionKey, "list")).entry).toBeUndefined();
      expect((await loadGatewayEntry(hidden.sessionKey)).entry?.sessionId).toBe(hidden.sessionId);
      expect(
        sessions.loadExactSessionEntryReadOnly({ ...hidden, storePath })?.entry.sessionId,
      ).toBe(hidden.sessionId);
      expectUnparsed(parse, "unrelated-session-");
    });
  }),
);

test(
  "refreshes children without response mutation",
  withStore(async ({ now, storePath }) => {
    const parentA = "agent:main:subagent:parent-a";
    const parentB = "agent:main:subagent:parent-b";
    const childA = "agent:main:subagent:child-a";
    const childB = "agent:main:subagent:child-b";
    const prompt = "parent saved skill prompt";
    const store: Record<string, SessionEntry> = {
      [parentA]: {
        ...session("parent-a", now),
        ...retainedDetails(now, prompt),
        toolOverrides: { mcpToolsDeny: { synthetic: ["blocked"] } },
      },
      [childA]: {
        ...session("child-a", now, parentA),
        ...retainedDetails(now, "child saved skill prompt", "child saved report"),
      },
      [parentB]: session("parent-b", now),
      [childB]: session("child-b", now, parentB),
    };
    await seed(storePath, store);

    const rowA = await rowReader.row(parentA, { now });
    const rowB = await rowReader.row(parentB, { now: now + 50 });
    const rowAAfterWindow = await rowReader.row(parentA, { now: now + 1_500 });

    expect(rowA?.childSessions).toEqual([childA]);
    expect(rowB?.childSessions).toEqual([childB]);
    expect(rowAAfterWindow?.childSessions).toEqual([childA]);
    for (const projection of [undefined, "list"] as const) {
      await withParseSpy(async (parse) => {
        const loaded = await loadChildren(parentA, projection);
        if (projection === undefined) {
          expect(loaded.entry?.skillsSnapshot).toEqual({ prompt, skills: [] });
          expect(loaded.entry?.systemPromptReport).toMatchObject({
            source: "run",
            generatedAt: now,
          });
        }
        expect(loaded.store[childA]).toMatchObject({
          sessionId: "child-a",
          parentSessionKey: parentA,
        });
        expectCompact(loaded.store[childA]);
        expectUnparsed(parse, "child saved skill prompt", "child saved report");
        const row = await rowReader.row(loaded.canonicalKey, { now });
        expect(row?.childSessions).toEqual([childA]);
        parse.mockClear();
        const lifecycle = await rowReader.snapshot(parentA, { now });
        expect(lifecycle.row).toEqual(row);
        expectUnparsed(parse, "saved skill prompt", '"systemPromptReport"');
        const denied = lifecycle.row?.toolOverrides?.mcpToolsDeny?.synthetic;
        if (!denied) {
          throw new Error("expected lifecycle tool overrides");
        }
        expect(denied).toEqual(["blocked"]);
        expect(Object.isFrozen(denied)).toBe(true);
        expect(() => denied.push("response-only")).toThrow(TypeError);
        expect((await rowReader.snapshot(parentA, { now })).row).toEqual(row);
      });
    }
    await sessions.updateSessionEntry({ sessionKey: parentA, storePath }, () => ({
      label: "fresh lifecycle label",
      updatedAt: now + 1,
    }));
    await sessions.updateSessionEntry({ sessionKey: childA, storePath }, () => ({
      parentSessionKey: parentB,
      updatedAt: now + 1,
    }));
    const fresh = await rowReader.snapshot(parentA, { now });
    expect(fresh.row?.label).toBe("fresh lifecycle label");
    expect(fresh.row?.childSessions).toBeUndefined();
    expect(rowA?.label).toBeUndefined();
    expect(rowA?.childSessions).toEqual([childA]);
  }),
);

test(
  "keeps navigation independent of control",
  withStore(async ({ now, storePath }) => {
    const oldParent = "agent:main:subagent:old-parent";
    const newParent = "agent:main:subagent:new-parent";
    const child = "agent:main:subagent:child";
    const navigation = "agent:main:dashboard:navigation";
    await seed(storePath, {
      [oldParent]: session("old-parent", now),
      [newParent]: session("new-parent", now),
      [navigation]: session("navigation", now),
      [child]: { ...session("child", now, navigation), spawnedBy: oldParent },
    });
    using oldControl = await control(child, oldParent, now);
    expect(await children(navigation, now)).toEqual([child]);
    oldControl[Symbol.dispose]();
    using _ = await control(child, newParent, now + 25);
    expect(await children(navigation, now + 50)).toEqual([child]);
    expect(await children(oldParent, now + 50)).toBeUndefined();
    expect(await children(newParent, now + 50)).toEqual([child]);
  }),
);

test.each([false, true])(
  "refreshes runtime-only children without host SQL or eager parsing (incognito=%s)",
  (incognito) =>
    withStore(async ({ now, storePath }) => {
      const agentId = "worker";
      const parentKey = incognito ? "agent:main:dashboard:incognito-parent" : "agent:main:parent";
      const childKey = `agent:${agentId}:subagent:child`;
      const childStorePath = resolveSessionStorePathCore(undefined, { agentId });
      const childTarget = { agentId, storePath: childStorePath, sessionKey: childKey };
      const childPrompt = "unused registry child prompt ".repeat(2048);
      await sessions.replaceSessionEntry(
        { agentId: MAIN_AGENT_ID, sessionKey: parentKey, ...(incognito ? {} : { storePath }) },
        { ...session("parent", now), ...(incognito ? { incognito: true } : {}) },
      );
      await sessions.replaceSessionEntry(childTarget, {
        ...session("child", now),
        ...retainedDetails(now, childPrompt),
      });
      using childControl = await control(childKey, parentKey, now);
      await withParseSpy(async (parse) => {
        const sql = observeHostDataSql();
        using _ = { [Symbol.dispose]: sql.restore };
        const loaded = await loadChildren(parentKey);
        expect(loaded.store[childKey]).toMatchObject({ sessionId: "child", updatedAt: now });
        expectCompact(loaded.store[childKey]);
        expectUnparsed(parse, childPrompt, '"systemPromptReport"');
        expect(sql.queries).toEqual([]);
      });
      expect(await children(parentKey, now)).toEqual([childKey]);

      await sessions.replaceSessionEntry(childTarget, {
        ...session("child", now + 1),
        label: "Updated child",
      });
      expect((await loadChildren(parentKey)).store[childKey]?.label).toBe("Updated child");

      await sessions.deleteSessionEntryLifecycle({
        agentId,
        storePath: childStorePath,
        archiveTranscript: false,
        target: { canonicalKey: childKey, storeKeys: [childKey] },
      });
      expect((await loadChildren(parentKey)).store[childKey]).toBeUndefined();
      expect(await children(parentKey, now)).toBeUndefined();
      childControl[Symbol.dispose]();
    })(),
);
