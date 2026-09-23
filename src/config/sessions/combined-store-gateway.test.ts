import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { retainSessionListForegroundWork } from "../../gateway/session-projection-work.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../../gateway/session-row-projection.js";
import { resolveSessionStoreKey } from "../../gateway/session-store-key.js";
import { listProjectedSessions } from "../../gateway/session-utils-list.js";
import { createGatewaySessionEntryReader } from "../../gateway/session-utils-store-lookup.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  inspectAgentDatabaseAdmission,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../../state/openclaw-database-preflight.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGatewayCore } from "./combined-store-gateway.js";
import * as sessionAccessor from "./session-accessor.js";
import {
  listSessionEntriesReadOnly,
  deleteSessionEntryLifecycle,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";

async function withResidentRows(
  cfg: OpenClawConfig,
  run: (projection: SessionRowProjection) => Promise<void>,
) {
  const projection = await createSessionRowProjection({ cfg });
  try {
    await run(projection);
  } finally {
    projection.dispose();
  }
}

it("lists admitted sessions across cached targets while preserving a refused database", async () => {
  await withOpenClawTestState({ label: "combined-admission" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true }, cleaner: {} } },
    };
    for (const agentId of ["main", "cleaner"]) {
      replaceSessionEntrySync(
        { agentId, sessionKey: `agent:${agentId}:main` },
        { sessionId: `${agentId}-session`, updatedAt: 1 },
      );
    }
    expect(
      Object.keys(
        loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly: true }).store,
      ),
    ).toHaveLength(2);
    const copyPath = openOpenClawAgentDatabase({ agentId: "cleaner" }).path;
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const copy = new DatabaseSync(copyPath);
    copy.exec(
      "PRAGMA user_version = 16; UPDATE schema_meta SET agent_id = 'main', schema_version = 16;",
    );
    copy.close();
    await assertOpenClawDatabasesReady({
      config: cfg,
      env: state.env,
      operation: "gateway-startup",
    });
    const refusal = readAgentDatabaseAdmissionRefusal("cleaner");
    expect(refusal).toBeDefined();
    const before = await fs.readFile(copyPath);

    for (const configuredAgentsOnly of [false, true]) {
      const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly });
      expect(Object.keys(combined.store)).toEqual(["agent:main:main"]);
      expect(combined.diagnostics?.join("\n")).toContain(refusal?.reason);
    }
    expect(() => loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "cleaner" })).toThrow(
      refusal?.reason,
    );
    const scoped = loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "main" });
    expect(
      scoped.targetsBySessionKey.get("agent:main:main")?.readSourceEntry("agent:cleaner:main"),
    ).toBeUndefined();
    expect(scoped.diagnostics?.join("\n")).toContain(refusal?.reason);
    expect(await fs.readFile(copyPath)).toEqual(before);

    const repaired = new DatabaseSync(copyPath);
    repaired.exec(
      `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}; UPDATE schema_meta SET agent_id = 'cleaner', schema_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`,
    );
    repaired.close();
    await assertOpenClawDatabasesReady({
      config: cfg,
      env: state.env,
      operation: "gateway-startup",
    });
    expect(
      Object.keys(
        loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly: true }).store,
      ),
    ).toHaveLength(2);
  });
});

it.each(["ops", "main"])(
  "rechecks %s admission after reading a shared store through a different logical owner",
  async (refusedAgentId) => {
    await withOpenClawTestState({ label: "combined-read-admission" }, async (state) => {
      const storePath = state.statePath("ops.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      replaceSessionEntrySync(
        { agentId: "ops", storePath, sessionKey: "agent:ops:main" },
        { sessionId: "ops-session", updatedAt: 1 },
      );
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: { default: true } } },
        session: { store: state.statePath("{agentId}.sqlite") },
      };
      const opts = { agentId: "ops", projection: "list" as const };
      const expected = loadCombinedSessionStoreForGatewayCore(cfg, opts);
      expect(expected.durableTargets).toEqual([{ agentId: "ops", storePath }]);
      expect(expected.targetsBySessionKey.get("agent:ops:main")?.storeTarget).toEqual({
        agentId: "main",
        storePath,
      });
      const refusal = inspectAgentDatabaseAdmission({
        agentId: refusedAgentId,
        path: storePath,
        metadata: { role: "agent", agentId: "replacement-owner" },
      })!;
      try {
        expect(() =>
          loadCombinedSessionStoreForGatewayCore(cfg, {
            ...opts,
            loadEntries: (target, projection) => {
              expect(target).toEqual({ agentId: "main", storePath });
              const rows = listSessionEntriesReadOnly({ ...target, projection });
              recordAgentDatabaseAdmissions([refusal], { source: "startup", env: state.env });
              return rows;
            },
          }),
        ).toThrow(expect.objectContaining({ name: "AgentDatabaseAdmissionError", refusal }));
      } finally {
        recordAgentDatabaseAdmissions([], { source: "startup", env: state.env });
      }
    });
  },
);

it.each(["global", "unknown"])("projects the recorded aggregate %s owner", async (sessionKey) => {
  await withOpenClawTestState({ label: "combined-list-owner" }, async () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global" },
      agents: {
        entries: {
          main: { default: true, model: { primary: "openai/gpt-5.4" } },
          research: { model: { primary: "openai/gpt-5.5" } },
        },
      },
    };
    replaceSessionEntrySync(
      { agentId: "research", sessionKey },
      { sessionId: "research-only", updatedAt: 42 },
    );
    const combined = loadCombinedSessionStoreForGatewayCore(cfg);
    expect(combined.targetsBySessionKey.get(sessionKey)?.agentId).toBe("research");
    await withResidentRows(cfg, async (projection) => {
      const opts = { includeGlobal: true, includeUnknown: true };
      const result = await listProjectedSessions({ projection, opts });
      expect
        .soft(result.sessions)
        .toMatchObject([
          { key: sessionKey, sessionId: "research-only", agentId: "research", model: "gpt-5.5" },
        ]);
      const searched = await listProjectedSessions({
        projection,
        opts: { ...opts, search: "gpt-5.5" },
      });
      expect.soft(searched.sessions.map((row) => row.sessionId)).toEqual(["research-only"]);
      expect(searched.defaults).toEqual(result.defaults);
    });
  });
});

it("projects shared rows under their logical owner while retaining the physical database owner", async () => {
  await withOpenClawTestState({ label: "combined-store-owner" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, worker: {} },
        defaults: { sessionStore: { agentId: "ops" } },
      },
      session: { scope: "global", store: storePath },
    };
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    for (const sessionKey of ["global", "unknown", "agent:worker:task"]) {
      replaceSessionEntrySync(
        { agentId: sessionKey.startsWith("agent:") ? "worker" : "ops", sessionKey, storePath },
        {
          sessionId: `session-${sessionKey}`,
          updatedAt: 1,
          displayName: sessionKey === "global" ? "Shared physical global title" : undefined,
        },
      );
    }
    await persistSessionTranscriptTurn(
      { agentId: "main", storePath, sessionKey: "global", sessionId: "session-global" },
      {
        messages: [{ message: { role: "user", content: "Shared physical global preview" } }],
        touchSessionEntry: false,
      },
    );

    await withResidentRows(cfg, async (projection) => {
      await vi.waitFor(() =>
        expect(
          projection.snapshot(
            { key: "global", agentId: "ops", storePath },
            { includeDerivedTitles: true, includeLastMessage: true },
          ).row,
        ).toMatchObject({
          derivedTitle: "Shared physical global title",
          lastMessagePreview: "Shared physical global preview",
        }),
      );
      for (const configuredAgentsOnly of [false, true]) {
        const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly });
        expect(combined.durableTargets).toEqual([{ agentId: "main", storePath }]);
        expect(
          [...combined.targetsBySessionKey.values()].map(({ storeTarget }) => storeTarget),
        ).toEqual([
          { agentId: "main", storePath },
          { agentId: "main", storePath },
          { agentId: "main", storePath },
        ]);
        expect(
          Object.fromEntries(
            [...combined.targetsBySessionKey].map(([key, target]) => [key, target.agentId]),
          ),
        ).toEqual({
          global: "ops",
          unknown: "ops",
          "agent:worker:task": "worker",
        });

        const ownerPreserving = loadCombinedSessionStoreForGatewayCore(cfg, {
          configuredAgentsOnly,
          preserveSentinelOwners: true,
        });
        const listed = await listProjectedSessions({
          projection,
          opts: {
            configuredAgentsOnly,
            includeGlobal: true,
            includeUnknown: true,
            includeDerivedTitles: true,
            includeLastMessage: true,
          },
        });
        expect(listed.sessions).toHaveLength(3);
        expect(listed.sessions).toContainEqual(
          expect.objectContaining({
            kind: "global",
            agentId: "ops",
            sessionId: "session-global",
            derivedTitle: "Shared physical global title",
            lastMessagePreview: "Shared physical global preview",
          }),
        );
        expect(listed.sessions).toContainEqual(
          expect.objectContaining({ kind: "unknown", agentId: "ops" }),
        );
        const globalRow = listed.sessions.find((row) => row.kind === "global")!;
        expect(
          [...ownerPreserving.targetsBySessionKey.values()].find(
            (target) => target.storeKey === globalRow.key && target.agentId === globalRow.agentId,
          ),
        ).toMatchObject({
          agentId: "ops",
          storeKey: "global",
          storeTarget: { agentId: "main", storePath },
        });
      }
      for (const [agentId, keys] of [
        ["main", []],
        ["ops", ["global", "unknown"]],
        ["worker", ["agent:worker:task"]],
      ] as const) {
        const combined = loadCombinedSessionStoreForGatewayCore(cfg, { agentId });
        expect(Object.keys(combined.store).toSorted()).toEqual([...keys].toSorted());
      }
    });
  });
});

it("keeps fixed-store ownership out of separate registered and suffixed databases", async () => {
  await withOpenClawTestState({ label: "combined-store-partitions" }, async (state) => {
    const storePath = state.statePath("shared.json");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {} },
        defaults: { sessionStore: { agentId: "ops" } },
      },
      session: { store: storePath },
    };
    for (const agentId of ["main", "ops"]) {
      replaceSessionEntrySync(
        { agentId, defaultAgentId: "main", sessionKey: "global", storePath },
        { sessionId: `global-${agentId}`, updatedAt: 1 },
      );
    }
    for (const agentId of ["main", "ops"]) {
      const combined = loadCombinedSessionStoreForGatewayCore(cfg, { agentId });
      expect(combined.store.global?.sessionId).toBe(`global-${agentId}`);
      expect(combined.targetsBySessionKey.get("global")?.agentId).toBe(agentId);
    }

    const registeredPath = state.statePath("separate.sqlite");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "unknown", storePath: registeredPath },
      { sessionId: "separate-main", updatedAt: 1 },
    );
    const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly: true });
    expect(combined.store.unknown?.sessionId).toBe("separate-main");
    expect(combined.targetsBySessionKey.get("unknown")).toMatchObject({
      agentId: "main",
      storeTarget: { agentId: "main", storePath: registeredPath },
    });
  });
});

it.each([
  { name: "physical sentinel", parent: "global", model: "qwen3:14b", source: "inherited" },
  {
    name: "qualified main alias",
    parent: "agent:main:main",
    model: "qwen3:8b",
    source: "inherited",
  },
  {
    name: "literal scoped sentinel",
    parent: "agent:main:global",
    model: "qwen3:32b",
    source: "inherited",
  },
  { name: "missing physical parent", parent: "global", model: "llama3.1:8b", source: null },
  {
    name: "missing qualified parent",
    parent: "agent:main:dashboard:missing",
    model: "llama3.1:8b",
    source: null,
  },
] as const)(
  "keeps $name model facts separate from displayed lineage",
  async ({ name, parent, model, source }) => {
    await withOpenClawTestState({ label: "combined-parent-model" }, async () => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: {
          entries: { main: { default: true }, work: {} },
          defaults: { model: { primary: "ollama/llama3.1:8b" } },
        },
      };
      const parents: Array<[string, string, string]> = [
        ["main", "global", "qwen3:8b"],
        ["main", "agent:main:global", "qwen3:32b"],
      ];
      if (name !== "missing physical parent") {
        parents.push(["work", "global", "qwen3:14b"]);
      }
      for (const [agentId, sessionKey, selectedModel] of parents) {
        replaceSessionEntrySync(
          { agentId, sessionKey },
          {
            sessionId: `${agentId}-${sessionKey}`,
            updatedAt: 1,
            providerOverride: "ollama",
            modelOverride: selectedModel,
            modelOverrideSource: "user",
            modelOverrideRouteResolution: "resolved",
          },
        );
      }
      const key = "agent:work:dashboard:child";
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: key },
        { sessionId: "child", updatedAt: 2, parentSessionKey: parent },
      );
      await withResidentRows(cfg, async (projection) => {
        for (const opts of [{}, { agentId: "work" }]) {
          const list = await listProjectedSessions({ projection, opts });
          expect(list.sessions.find((row) => row.key === key)).toMatchObject({
            agentId: "work",
            modelProvider: "ollama",
            model,
            modelOverrideSource: source,
            parentSessionKey: parent === "agent:main:main" ? "global" : parent,
          });
          const searched = await listProjectedSessions({
            projection,
            opts: { ...opts, search: model },
          });
          expect(searched.sessions.some((row) => row.key === key)).toBe(true);
        }
      });
    });
  },
);

it.each(["global", "per-sender"] as const)(
  "selects a later stored parent before its current alias in %s views",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        session: { scope, mainKey: "work" },
        agents: {
          entries: { alpha: { default: true }, main: {} },
          defaults: { model: { primary: "ollama/llama3.1:8b" } },
        },
      };
      await state.writeConfig(cfg);
      state.applyEnv();
      const parent = "agent:main:main";
      const alias = scope === "global" ? "global" : "agent:main:work";
      const key = "agent:alpha:dashboard:child";
      const child = {
        sessionId: "child",
        updatedAt: 2,
        status: "running" as const,
        parentSessionKey: parent,
        spawnedBy: parent,
      };
      const writeParent = (sessionKey: string, model: string) =>
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            providerOverride: "ollama",
            modelOverride: model,
            modelOverrideSource: "user",
            modelOverrideRouteResolution: "resolved",
          },
        );
      replaceSessionEntrySync({ agentId: "alpha", sessionKey: key }, child);
      writeParent(alias, "qwen3:8b");
      writeParent(parent, "qwen3:32b");
      expect(resolveSessionStoreKey({ cfg, sessionKey: parent })).toBe(alias);
      const release = retainSessionListForegroundWork();
      try {
        await withResidentRows(cfg, async (projection) => {
          const check = async (model: string, literal: boolean) => {
            const displayParent = literal || scope !== "global" ? parent : "global";
            for (const opts of [{}, { agentId: "alpha" }]) {
              // Alpha loads first; both the full inventory and a missing-owner exact join agree.
              const combined = loadCombinedSessionStoreForGatewayCore(cfg, opts);
              expect(combined.store[key]).toMatchObject({
                parentSessionKey: displayParent,
                spawnedBy: displayParent,
              });
              const reads = vi.spyOn(sessionAccessor, "loadExactSessionEntryCandidates");
              try {
                const source = combined.targetsBySessionKey.get(key)!;
                expect(source.readSourceEntry(parent)?.modelOverride).toBe(model);
                const firstReads = reads.mock.calls.length;
                if (scope === "global") {
                  expect(firstReads).toBe(0);
                }
                expect(source.readSourceEntry(parent)?.modelOverride).toBe(model);
                expect(reads.mock.calls).toHaveLength(firstReads);
              } finally {
                reads.mockRestore();
              }
              const list = await listProjectedSessions({ projection, opts });
              expect(list.sessions.find((row) => row.key === key)).toMatchObject({
                parentSessionKey: displayParent,
                spawnedBy: displayParent,
                model,
                modelOverrideSource: "inherited",
              });
            }
            const read = createGatewaySessionEntryReader({
              cfg,
              agentId: "alpha",
              store: { [key]: child },
            });
            expect(read(parent)?.modelOverride).toBe(model);
            const filtered = await listProjectedSessions({
              projection,
              opts: { spawnedBy: displayParent },
            });
            expect(filtered.sessions.map((row) => row.key)).toContain(key);
            const children =
              projection.snapshot({ agentId: "main", key: literal ? parent : alias }).row
                ?.childSessions ?? [];
            if (literal || scope === "global") {
              expect(children).toContain(key);
            } else {
              // Per-sender navigation keeps the missing literal address, even with model fallback.
              expect(children).not.toContain(key);
            }
            if (literal) {
              expect(
                projection.snapshot({ agentId: "main", key: alias }).row?.childSessions ?? [],
              ).not.toContain(key);
            }
          };
          await check("qwen3:32b", true);
          writeParent(alias, "qwen3:14b");
          await check("qwen3:32b", true);
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: projection.capture({ agentId: "main", key: parent })!.storeTarget.storePath,
            archiveTranscript: false,
            target: { canonicalKey: parent, storeKeys: [parent] },
          });
          await check("qwen3:14b", false);
          writeParent(alias, "qwen3:8b");
          await check("qwen3:8b", false);
          writeParent(parent, "qwen3:32b");
          await check("qwen3:32b", true);
        });
      } finally {
        release();
      }
    });
  },
);

it.each([false, true])(
  "retains scoped removed-default alias selection (present=%s)",
  async (present) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: { default: true }, work: {} } },
      };
      await state.writeConfig(cfg);
      state.applyEnv();
      if (present) {
        replaceSessionEntrySync(
          { agentId: "ops", sessionKey: "agent:ops:main" },
          { sessionId: "replacement-owner", updatedAt: 1, modelOverride: "qwen3:8b" },
        );
      }
      const key = "agent:work:dashboard:child";
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: key },
        { sessionId: "child", updatedAt: 1, parentSessionKey: "agent:main:main" },
      );
      const scoped = loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "work" });
      expect(scoped.store[key]?.parentSessionKey).toBe("agent:main:main");
      const source = scoped.targetsBySessionKey.get(key)!;
      expect(source.readSourceEntry("agent:main:main")?.sessionId).toBe(
        present ? "replacement-owner" : undefined,
      );
      const reads = vi.spyOn(sessionAccessor, "loadExactSessionEntryCandidates");
      try {
        expect(source.readSourceEntry("agent:main:main")?.sessionId).toBe(
          present ? "replacement-owner" : undefined,
        );
        expect(reads).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
      }
    });
  },
);

it("reads a raw parent from the child's captured shared physical store", async () => {
  await withOpenClawTestState({ label: "combined-shared-parent-model" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, work: {} },
        defaults: { sessionStore: { agentId: "ops" }, model: { primary: "ollama/llama3.1:8b" } },
      },
      session: { scope: "global", store: storePath },
    };
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    replaceSessionEntrySync(
      { agentId: "ops", sessionKey: "global", storePath },
      {
        sessionId: "ops-parent",
        updatedAt: 1,
        providerOverride: "ollama",
        modelOverride: "qwen3:14b",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      },
    );
    const key = "agent:work:dashboard:shared-child";
    replaceSessionEntrySync(
      { agentId: "work", sessionKey: key, storePath },
      { sessionId: "shared-child", updatedAt: 2, parentSessionKey: "global" },
    );
    const combined = loadCombinedSessionStoreForGatewayCore(cfg);
    expect(combined.targetsBySessionKey.get(key)?.storeTarget).toEqual({
      agentId: "main",
      storePath,
    });
    await withResidentRows(cfg, async (projection) => {
      const listed = await listProjectedSessions({ projection, opts: {} });
      const expected = {
        agentId: "work",
        model: "qwen3:14b",
        modelOverrideSource: "inherited",
      };
      expect(listed.sessions.find((row) => row.key === key)).toMatchObject(expected);
      const scoped = await listProjectedSessions({
        projection,
        opts: { agentId: "work" },
      });
      expect(scoped.sessions).toMatchObject([expected]);
    });
  });
});

it.for([false, true])(
  "preserves qualified retired-owner keys in a shared store (alias=%s)",
  async (alias, context) => {
    if (alias && process.platform === "win32") {
      context.skip();
    }
    await withOpenClawTestState({ label: "combined-store-retired-owner" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, worker: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { store: storePath },
      };
      const physicalPath = alias
        ? path.join(state.agentDir("main"), "openclaw-agent.sqlite")
        : storePath;
      openOpenClawAgentDatabase({ agentId: "main", path: physicalPath });
      if (alias) {
        await fs.symlink(physicalPath, storePath);
      }
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:main", storePath },
        { sessionId: "retired-main", updatedAt: 1 },
      );
      replaceSessionEntrySync(
        { agentId: "ops", sessionKey: "global", storePath },
        {
          sessionId: "ops-global",
          updatedAt: 1,
          parentSessionKey: "agent:main:main",
          spawnedBy: "agent:main:main",
        },
      );

      // Repeat the configured-only load to exercise the prepared target snapshot.
      for (const configuredAgentsOnly of [false, true, true]) {
        const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly });
        if (configuredAgentsOnly) {
          expect(combined.store["agent:main:main"]).toBeUndefined();
          expect(combined.targetsBySessionKey.has("agent:main:main")).toBe(false);
        } else {
          expect(combined.store["agent:main:main"]?.sessionId).toBe("retired-main");
          expect(combined.targetsBySessionKey.get("agent:main:main")?.agentId).toBe("main");
        }
        expect(combined.targetsBySessionKey.get("global")?.agentId).toBe("ops");
        expect(combined.store.global).toMatchObject({
          parentSessionKey: "agent:main:main",
          spawnedBy: "agent:main:main",
        });
      }
      expect(loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "ops" }).store).toEqual({
        global: expect.objectContaining({ sessionId: "ops-global" }),
      });
    });
  },
);

it.for(["main", "unknown", "global"])(
  "resolves global lineage aliases without folding sentinels (mainKey=%s)",
  async (mainKey) => {
    await withOpenClawTestState({ label: "combined-store-global-lineage" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {}, worker: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { scope: "global", mainKey, store: storePath },
      };
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      setCanonicalSqliteSessionMainKey(database, mainKey);
      for (const sessionKey of ["global", "unknown"]) {
        replaceSessionEntrySync(
          { agentId: "ops", sessionKey, storePath },
          { sessionId: `parent-${sessionKey}`, updatedAt: Date.now() },
        );
      }
      for (const [name, parentSessionKey, parentSessionId] of [
        ["alias", `agent:ops:${mainKey}`, "parent-global"],
        ["global", "global", "parent-global"],
        ["unknown", "unknown", "parent-unknown"],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "worker", sessionKey: `agent:worker:subagent:${name}`, storePath },
          {
            sessionId: `child-${name}`,
            updatedAt: Date.now(),
            status: "running",
            parentSessionId,
            parentSessionKey,
            spawnedBy: parentSessionKey,
          },
        );
      }
      await withResidentRows(cfg, async (projection) => {
        for (const [spawnedBy, children] of [
          ["global", ["alias", "global"]],
          ["unknown", ["unknown"]],
        ] as const) {
          const selected = await listProjectedSessions({
            projection,
            opts: { spawnedBy, configuredAgentsOnly: true },
          });
          expect(selected.sessions.map(({ key }) => key).toSorted()).toEqual(
            children.map((name) => `agent:worker:subagent:${name}`).toSorted(),
          );
        }
      });
    });
  },
);

it("filters retired stores by canonical lineage owners without selecting an implicit agent", async () => {
  await withOpenClawTestState({ label: "combined-store-retired-lineage" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: state.statePath("agents", "{agentId}", "sessions", "sessions.json") },
    };
    const storePath = state.statePath("agents", "archive", "sessions", "sessions.json");
    for (const [name, parentSessionKey] of [
      ["retired", "agent:main:main"],
      ["configured", "agent:ops:main"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "archive", sessionKey: `agent:archive:${name}`, storePath },
        { sessionId: name, updatedAt: 1, parentSessionKey, spawnedBy: parentSessionKey },
      );
    }
    const unfiltered = loadCombinedSessionStoreForGatewayCore(cfg);
    expect(unfiltered.store["agent:archive:retired"]).toMatchObject({
      parentSessionKey: "agent:main:main",
      spawnedBy: "agent:main:main",
    });
    const filtered = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly: true });
    expect(Object.keys(filtered.store)).toEqual(["agent:archive:configured"]);
    expect(
      Object.fromEntries(
        [...filtered.targetsBySessionKey].map(([key, target]) => [key, target.agentId]),
      ),
    ).toEqual({
      "agent:archive:configured": "archive",
    });
    expect(filtered.store["agent:archive:configured"]).toMatchObject({
      parentSessionKey: "agent:ops:main",
      spawnedBy: "agent:ops:main",
    });
  });
});

it.skipIf(process.platform === "win32")(
  "keeps suffix owners when a legacy selector aliases the shared database",
  async () => {
    await withOpenClawTestState({ label: "combined-store-selector-alias" }, async (state) => {
      const storePath = state.statePath("shared.json");
      const sqlitePath = state.statePath("shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {}, worker: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { store: storePath },
      };
      openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
      await fs.symlink(sqlitePath, storePath);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "global", storePath },
        { sessionId: "main-global", updatedAt: 1 },
      );
      replaceSessionEntrySync(
        { agentId: "worker", defaultAgentId: "main", sessionKey: "unknown", storePath },
        { sessionId: "worker-unknown", updatedAt: 1 },
      );
      for (const configuredAgentsOnly of [false, true, true]) {
        const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly });
        expect(combined.store.unknown?.sessionId).toBe("worker-unknown");
        expect(combined.targetsBySessionKey.get("unknown")?.agentId).toBe("worker");
        expect(combined.store.global?.sessionId).toBe("main-global");
        expect(combined.targetsBySessionKey.get("global")?.agentId).toBe("main");
      }
      const scoped = loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "worker" });
      expect(scoped.targetsBySessionKey.get("unknown")?.agentId).toBe("worker");
      expect(loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "ops" }).store).toEqual({});
      expect(
        loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "main" }).targetsBySessionKey.get(
          "global",
        )?.agentId,
      ).toBe("main");
    });
  },
);

it("omits retained prompt payloads unless a caller opts into the full projection", async () => {
  await withOpenClawTestState({ label: "combined-store-projection" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
    };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:main" },
      {
        sessionId: "prompt-payload-session",
        updatedAt: 7,
        skillsSnapshot: { prompt: "skill prompt body", skills: [{ name: "example" }] },
        systemPromptReport: {
          source: "run",
          generatedAt: 7,
          systemPrompt: { chars: 17, projectContextChars: 0, nonProjectContextChars: 17 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 17, entries: [{ name: "example", blockChars: 17 }] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      },
    );

    const defaultEntry = loadCombinedSessionStoreForGatewayCore(cfg).store["agent:main:main"];
    expect.soft(defaultEntry?.sessionId).toBe("prompt-payload-session");
    expect.soft(defaultEntry?.skillsSnapshot).toBeUndefined();
    expect.soft(defaultEntry?.systemPromptReport).toBeUndefined();

    const fullEntry = loadCombinedSessionStoreForGatewayCore(cfg, { projection: "full" }).store[
      "agent:main:main"
    ];
    expect.soft(fullEntry?.skillsSnapshot?.prompt).toBe("skill prompt body");
    expect(fullEntry?.systemPromptReport?.systemPrompt.chars).toBe(17);
  });
});
