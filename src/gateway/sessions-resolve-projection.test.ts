import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState as withRawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { artifactsHandlers } from "./server-methods/artifacts.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type { RespondFn } from "./server-methods/types.js";
import {
  resetResolvedSessionKeyForRunCacheForTest,
  resolveSessionKeyForRun,
} from "./server-session-key.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

const scope = { agentId: "main", sessionKey: "agent:main:target" };
const entry = { sessionId: "target-id", updatedAt: 1, label: "original" };
const cfg: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { main: {} } },
};
const selectors: SessionsResolveParams[] = [
  { key: scope.sessionKey, agentId: "main" },
  { sessionId: entry.sessionId, agentId: "main" },
  { sessionId: entry.sessionId },
  { label: entry.label, agentId: "main" },
];

const projections = new Map<OpenClawConfig, Promise<SessionRowProjection>>();
function projectionFor(config = cfg) {
  let projection = projections.get(config);
  if (!projection) {
    projection = createSessionRowProjection({ cfg: config });
    projections.set(config, projection);
  }
  return projection;
}
async function withOpenClawTestState(
  options: Parameters<typeof withRawTestState>[0],
  fn: Parameters<typeof withRawTestState>[1],
) {
  return withRawTestState(options, async (state) => {
    try {
      return await fn(state);
    } finally {
      for (const pending of projections.values()) {
        (await pending).dispose();
      }
      projections.clear();
    }
  });
}
async function resolve(p: SessionsResolveParams) {
  return resolveSessionKeyFromResolveParams({
    client: null,
    p,
    projection: await projectionFor(),
  });
}

const resolved = { ok: true, key: scope.sessionKey, agentId: "main" };

describe("session resolution metadata", () => {
  it.each(["key", "sessionId", "shortId", "reference", "label"] as const)(
    "resolves parent-scoped %s requests without hydrating retained subagent tasks",
    async (selector) => {
      await withOpenClawTestState(
        { env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async () => {
          const now = Date.now();
          const parent = "agent:main:main";
          const key = "agent:main:subagent:12345678-0aaa-4000-8000-000000000001";
          const selected = { ...entry, updatedAt: now, spawnedBy: parent };
          replaceSessionEntrySync({ ...scope, sessionKey: key }, selected);
          const rows = [key, "agent:main:subagent:retained"].map((childSessionKey, index) => ({
            runId: `resolve-run-${index}`,
            childSessionKey,
            requesterSessionKey: parent,
            requesterDisplayKey: "main",
            task: `retained-resolve-task:${"x".repeat(16_384)}`,
            cleanup: "keep" as const,
            createdAt: now - 100,
            execution: { status: "terminal" as const, startedAt: now - 100, endedAt: now - 50 },
            completion: { required: false },
            delivery: { status: "not_required" as const },
          }));
          saveSubagentRegistryToSqlite(new Map(rows.map((row) => [row.runId, row])));
          clearSubagentRunsReadCacheForTest();
          const value =
            selector === "sessionId"
              ? selected.sessionId
              : selector === "shortId"
                ? "12345678"
                : selector === "label"
                  ? selected.label
                  : selector === "reference"
                    ? { key }
                    : key;
          const projection = await projectionFor();
          const respond = vi.fn();
          const parse = vi.spyOn(JSON, "parse");
          try {
            await expectDefined(
              sessionReadHandlers["sessions.resolve"],
              "resolve handler",
            )({
              params: { [selector]: value, spawnedBy: parent, agentId: "main" },
              context: createDirectChatContext({
                getRuntimeConfig: () => cfg,
                ...bindSessionRowProjection({}, () => projection),
              }),
              req: { type: "req", id: "registry-resolve", method: "sessions.resolve" },
              client: null,
              isWebchatConnect: () => false,
              respond,
            });
            expect(respond).toHaveBeenCalledWith(
              true,
              expect.objectContaining({ ok: true, key, agentId: "main" }),
              undefined,
            );
            expect(parse.mock.calls.some(([json]) => json.includes("retained-resolve-task:"))).toBe(
              false,
            );
          } finally {
            parse.mockRestore();
            clearSubagentRunsReadCacheForTest();
          }
        },
      );
    },
  );

  it.each(selectors)("resolves %j without decoding unrelated saved prompts", async (p) => {
    await withOpenClawTestState({ label: "resolve-prompts" }, async () => {
      replaceSessionEntrySync(scope, entry);
      for (let index = 0; index < 3; index++) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:main:sibling-${index}` },
          {
            sessionId: `sibling-${index}`,
            updatedAt: 1,
            skillsSnapshot: { prompt: "unrelated-resolve-prompt".repeat(1024), skills: [] },
          },
        );
      }
      await projectionFor();
      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(await resolve(p)).toEqual(resolved);
        expect(
          parse.mock.calls.filter(([json]) => json.includes("unrelated-resolve-prompt")),
        ).toHaveLength(0);
      } finally {
        parse.mockRestore();
      }
    });
  });

  it("hydrates external changes at startup and observes tracked changes while resident", async () => {
    await withOpenClawTestState({ label: "resolve-freshness" }, async () => {
      const client = identifiedClient(
        roleClient("view", "resolve-viewer").authenticatedUserProfile!.profileId,
      );
      const roleCfg = { ...cfg, ...rolePolicyConfig() };
      const visible = { ...entry, visibility: "shared" as const };
      replaceSessionEntrySync(scope, visible);
      const lookup = async (p: SessionsResolveParams) =>
        resolveSessionKeyFromResolveParams({
          client,
          p,
          projection: await projectionFor(roleCfg),
        });
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await lookup({ key: scope.sessionKey })).toEqual(resolved);
        expect(await lookup({ label: entry.label })).toEqual(resolved);
      }
      const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
      try {
        const hidden = { ...visible, label: "external", visibility: "draft" };
        external
          .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
          .run(JSON.stringify(hidden), hidden.label, scope.sessionKey);
        (await projectionFor(roleCfg)).dispose();
        projections.delete(roleCfg);
        expect(await lookup({ key: scope.sessionKey, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        expect(await lookup({ label: entry.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        const tracked = { ...visible, label: "tracked" };
        replaceSessionEntrySync(scope, tracked);
        expect(await lookup({ key: scope.sessionKey })).toEqual(resolved);
        expect(await lookup({ label: tracked.label })).toEqual(resolved);
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
      } finally {
        external.close();
      }
    });
  });

  it("does not publish a discovery result after its session becomes a foreign draft", async () => {
    await withOpenClawTestState({ label: "resolve-publication-visibility" }, async () => {
      const client = roleClient("view", "resolve-publication-viewer");
      const owner = roleClient("write", "resolve-publication-owner");
      const roleCfg = { ...cfg, ...rolePolicyConfig() };
      const visible = {
        ...entry,
        visibility: "shared" as const,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: owner.authenticatedUserProfile!.profileId,
        },
      };
      replaceSessionEntrySync(scope, visible);
      const projection = await projectionFor(roleCfg);
      await projection.ensureMaterialized();
      const context = createDirectChatContext({
        getRuntimeConfig: () => roleCfg,
        ...bindSessionRowProjection({}, () => projection),
      });
      const publications: Array<{
        visibility: string | undefined;
        response: Parameters<RespondFn>;
      }> = [];
      const request = () =>
        expectDefined(
          sessionReadHandlers["sessions.resolve"],
          "resolve handler",
        )({
          params: { reference: { key: scope.sessionKey }, agentId: "main", allowMissing: true },
          context,
          req: { type: "req", id: "resolve-publication", method: "sessions.resolve" },
          client,
          isWebchatConnect: () => false,
          respond: (...response) => {
            publications.push({ visibility: loadSessionEntry(scope)?.visibility, response });
          },
        });
      await request();
      const pending = request();
      replaceSessionEntrySync(scope, { ...visible, visibility: "draft" });
      await pending;
      await request();

      const found = [true, { ...resolved, displayName: entry.label }, undefined];
      const missing = [true, { ok: false }, undefined];
      expect(publications).toHaveLength(3);
      expect(publications[0]).toEqual({ visibility: "shared", response: found });
      const raced = publications[1]!;
      expect(raced.response).toEqual(raced.visibility === "shared" ? found : missing);
      expect(publications[2]).toEqual({ visibility: "draft", response: missing });
    });
  });

  it.each(["malformed", "nul", "mismatched-time", "mismatched-window"])(
    "preserves warm and cold storage-reader outcomes for %s rows",
    async (kind) => {
      await withOpenClawTestState({ label: "resolve-corruption" }, async () => {
        const siblingKey = "agent:main:sibling";
        replaceSessionEntrySync(scope, entry);
        replaceSessionEntrySync(
          { ...scope, sessionKey: siblingKey },
          { sessionId: "sibling", updatedAt: 1 },
        );
        const read = (key: string) => {
          const target = resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key,
            agentId: "main",
            projection: "list",
            clone: false,
          });
          return target.store[target.canonicalKey];
        };
        expect(read(scope.sessionKey)?.sessionId).toBe(entry.sessionId);
        const database = openOpenClawAgentDatabase(scope).db;
        if (kind === "malformed" || kind === "nul") {
          database
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run(
              kind === "malformed" ? "{" : JSON.stringify(entry) + "\0trailing",
              scope.sessionKey,
            );
        } else if (kind === "mismatched-time") {
          database
            .prepare("UPDATE session_nodes SET updated_at = ? WHERE session_key = ?")
            .run(2, scope.sessionKey);
        } else {
          database
            .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
            .run("different", scope.sessionKey);
        }
        expect(read(scope.sessionKey)?.sessionId).toBe(
          kind === "mismatched-window" ? entry.sessionId : undefined,
        );
        expect(read(siblingKey)?.sessionId).toBe("sibling");
        closeOpenClawAgentDatabasesForTest();
        for (const key of [scope.sessionKey, siblingKey]) {
          expect(() => read(key)).toThrow(
            expect.objectContaining({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" }),
          );
        }
      });
    },
  );
});

// Marker lives only in sibling rows the lookups must never decode. A decode of
// this text means a store-wide read carried saved prompts into JavaScript.
const SIBLING_MARKER = "unrelated-lookup-prompt";
const SIBLING_PROMPT = SIBLING_MARKER.repeat(1600);
const TARGET_PROMPT = "target-lookup-prompt".repeat(1600);
const SIBLING_ROWS = 24;

function systemPromptReport(chars: number) {
  return {
    source: "run" as const,
    generatedAt: 1,
    systemPrompt: { chars, projectContextChars: 0, nonProjectContextChars: chars },
    injectedWorkspaceFiles: [],
    skills: { promptChars: chars, entries: [{ name: "seeded-skill", blockChars: chars }] },
    tools: { listChars: 0, schemaChars: 0, entries: [] },
  };
}

function seedStore() {
  replaceSessionEntrySync(scope, {
    sessionId: "target-id",
    updatedAt: 2,
    skillsSnapshot: { prompt: TARGET_PROMPT, skills: [{ name: "target-skill" }] },
    systemPromptReport: systemPromptReport(TARGET_PROMPT.length),
  });
  for (let index = 0; index < SIBLING_ROWS; index++) {
    replaceSessionEntrySync(
      { ...scope, sessionKey: `agent:main:sibling-${index}` },
      {
        sessionId: `sibling-${index}`,
        updatedAt: 1,
        skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [{ name: "sibling-skill" }] },
        systemPromptReport: systemPromptReport(SIBLING_PROMPT.length),
      },
    );
  }
}

/** Counts JSON.parse calls that decoded the sibling marker. */
function measureSiblingDecodes<T>(run: () => T): { result: T; decodes: number } {
  const parse = vi.spyOn(JSON, "parse");
  try {
    const result = run();
    const matched = parse.mock.calls.flatMap(([json]) =>
      typeof json === "string" && json.includes(SIBLING_MARKER) ? [json] : [],
    );
    return {
      result,
      decodes: matched.length,
    };
  } finally {
    parse.mockRestore();
  }
}

describe("gateway session lookups", () => {
  it("artifacts.list resolves known and missing runs without decoding unrelated saved prompts", async () => {
    await withOpenClawTestState({ label: "lookup-runid-projection" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      seedStore();
      resetResolvedSessionKeyForRunCacheForTest();

      const parse = vi.spyOn(JSON, "parse");
      try {
        for (const runId of ["target-id", "absent-run-id"]) {
          const respond = vi.fn();
          await expectDefined(
            artifactsHandlers["artifacts.list"],
            "artifact list handler",
          )({
            params: { runId, agentId: "main" },
            context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
            req: { type: "req", id: runId, method: "artifacts.list" },
            client: null,
            isWebchatConnect: () => false,
            respond,
          });
          if (runId === "target-id") {
            expect(respond).toHaveBeenCalledWith(true, { artifacts: [] });
          } else {
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({
                details: { type: "artifact_scope_not_found" },
              }),
            );
          }
        }
        expect(parse.mock.calls.some(([json]) => json.includes(SIBLING_MARKER))).toBe(false);
      } finally {
        parse.mockRestore();
        resetResolvedSessionKeyForRunCacheForTest();
      }
    });
  });

  it("keeps the freshest same-session-id row when prompts are not decoded", async () => {
    await withOpenClawTestState({ label: "lookup-projection-freshness" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      // Same sessionId on two keys: selection depends on updatedAt surviving the
      // metadata projection, which is the field a bad projection would drop.
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:stale" },
        {
          sessionId: "shared-id",
          updatedAt: 1,
          skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [] },
        },
      );
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:fresh" },
        {
          sessionId: "shared-id",
          updatedAt: 99,
          skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [] },
        },
      );
      resetResolvedSessionKeyForRunCacheForTest();

      const observed = measureSiblingDecodes(() =>
        resolveSessionKeyForRun("shared-id", { agentId: "main" }),
      );
      expect(observed.result).toBe("fresh");
      expect(observed.decodes).toBe(0);
    });
  });
});
