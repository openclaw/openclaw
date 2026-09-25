import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import * as transcriptPreview from "../session-transcript-preview.js";
import type { SessionsListResult } from "../session-utils.types.js";
import {
  directSessionReq,
  seedLinearSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "./sessions-read-cache.test-support.js";

setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

const prompt = "saved prompt not needed for search or previews ".repeat(2048);
const owner = { type: "human", source: "profile", id: "owner@example.com" } as const;

test("sessions.list distinguishes selection sources for identical selected values", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} }, defaults: { model: "fixture/selected" } },
      plugins: { enabled: false },
    };
    const configured = "agent:main:configured";
    const pinned = "agent:main:pinned";
    const inherited = "agent:main:inherited";
    const runtime = "agent:main:runtime";
    const entries = [
      { key: configured, overrides: {} },
      {
        key: pinned,
        overrides: { providerOverride: "fixture", modelOverride: "selected" },
      },
      { key: inherited, overrides: { parentSessionKey: pinned } },
      {
        key: runtime,
        overrides: { agentHarnessId: "fixture-harness", modelSelectionLocked: true },
      },
    ];
    for (const { key, overrides } of entries) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { sessionId: key, updatedAt: 1, visibility: "shared", ...overrides },
      );
    }
    const bindings = new Map([[runtime, { provider: "fixture", model: "selected" }]]);
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "fixture-harness",
      source: "test",
      harness: {
        id: "fixture-harness",
        label: "Selection owner",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("session listing must not start inference");
        },
        resolveSessionRuntimeOwnership: (params) => {
          params.assertCurrent();
          const modelRef = bindings.get(params.sessionId);
          return modelRef ? { model: "native", auth: "native", modelRef } : undefined;
        },
      },
    });
    setActivePluginRegistry(registry);

    for (const runtimeSource of ["runtime", "configured"]) {
      if (runtimeSource === "configured") {
        bindings.delete(runtime);
      }
      const response = await directSessionReq<SessionsListResult>(
        "sessions.list",
        { agentId: "main" },
        { context: { getRuntimeConfig: () => cfg, loadGatewayModelCatalog: async () => [] } },
      );
      expect(response.ok, response.error?.message).toBe(true);
      expect(response.payload?.sessions).toHaveLength(4);
      for (const [key, modelSelectionSource] of [
        [configured, "configured"],
        [pinned, "override"],
        [inherited, "override"],
        [runtime, runtimeSource],
      ]) {
        expect(response.payload?.sessions.find((row) => row.key === key)).toMatchObject({
          modelProvider: "fixture",
          model: "selected",
          modelSelectionSource,
        });
      }
      expect(response.payload?.sessions.find((row) => row.key === inherited)).toMatchObject({
        modelOverrideSource: "inherited",
      });
    }
  });
});

async function seedMetadataReads(prepareProjection = false) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  const storePath = path.join(stateDir, "shared-search.sqlite");
  const viewer = ensureProfileForEmail("viewer@example.com");
  const definitions = {
    reader: {
      sessions: { others: "view" as const },
      agents: "*" as const,
      scopes: ["operator.read"],
    },
    restricted: {
      sessions: { others: "none" as const },
      agents: "*" as const,
      scopes: ["operator.read"],
    },
  } satisfies Record<string, GatewayOperatorRoleDefinition>;
  let cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    session: { store: storePath },
    gateway: {
      roles: {
        default: "reader",
        definitions,
      },
    },
  };
  for (const [agentId, name, visibility, incognito, content] of [
    ["main", "first", "shared", false, "needle alpha"],
    ["main", "second", "shared", false, `needle beta ${"context ".repeat(20)}`],
    ["main", "draft", "draft", false, "needle private"],
    ["main", "private", "shared", true, "needle incognito"],
    ["work", "other", "shared", false, "needle other agent"],
  ] as const) {
    const scope = { agentId, sessionKey: `agent:${agentId}:${name}`, storePath };
    const sessionId = `${agentId}-${name}`;
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: 1,
      createdActor: owner,
      visibility,
      ...(incognito ? { incognito: true as const } : {}),
      skillsSnapshot: { prompt, skills: [] },
    });
    await seedLinearSessionTranscript({ ...scope, sessionId, contents: [content] });
  }
  closeOpenClawAgentDatabasesForTest();
  const context = { ...requestContext(cfg), getRuntimeConfig: () => cfg };
  if (prepareProjection) {
    await initializeSessionReadContext(context);
  }
  return {
    storePath,
    viewerId: viewer.id,
    restrictRuntimeConfig: () => {
      cfg = { ...cfg, gateway: { roles: { default: "restricted", definitions } } };
    },
    opts: {
      client: identifiedClient(viewer.id),
      context,
    },
  };
}

test.each([
  { method: "sessions.search", scope: "unfiltered", sessionKeys: undefined },
  {
    method: "sessions.search",
    scope: "explicit keys",
    sessionKeys: [
      "agent:main:first",
      "agent:main:second",
      "agent:main:draft",
      "agent:main:private",
      "agent:main:missing",
      "agent:main:first",
    ],
  },
  { method: "sessions.preview", scope: "explicit keys", sessionKeys: undefined },
] as const)(
  "$method ($scope) retains visible results without decoding saved prompts",
  async ({ method, sessionKeys }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { opts, storePath } = await seedMetadataReads(method === "sessions.preview");
      const parse = JSON.parse;
      let decodedPromptBytes = 0;
      const parsed = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
        if (typeof value === "string" && value.includes(prompt)) {
          decodedPromptBytes += Buffer.byteLength(value);
        }
        return parse(value, reviver);
      });
      try {
        if (method === "sessions.search") {
          const all = await directSessionReq<{ results: Array<{ sessionKey: string }> }>(
            method,
            { query: "needle", ...(sessionKeys ? { sessionKeys } : {}) },
            opts,
          );
          expect(all.ok, all.error?.message).toBe(true);
          expect(all.payload?.results.map((hit) => hit.sessionKey)).toEqual([
            "agent:main:first",
            "agent:main:second",
          ]);
          expect(
            await directSessionReq(
              method,
              { query: "needle", limit: 1, ...(sessionKeys ? { sessionKeys } : {}) },
              opts,
            ),
          ).toMatchObject({
            ok: true,
            payload: { results: [all.payload?.results[0]], truncated: true },
          });
        } else {
          expect(
            await directSessionReq(
              method,
              { keys: ["agent:main:first", "agent:main:draft", "agent:main:private"] },
              opts,
            ),
          ).toMatchObject({
            ok: true,
            payload: {
              previews: [
                {
                  key: "agent:main:first",
                  status: "ok",
                  items: [{ role: "user", text: "needle alpha" }],
                },
                { key: "agent:main:draft", status: "missing", items: [] },
                { key: "agent:main:private", status: "missing", items: [] },
              ],
            },
          });
        }
        expect(decodedPromptBytes).toBe(0);
      } finally {
        parsed.mockRestore();
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:first", storePath },
        { visibility: "draft" },
      );
      const after = await directSessionReq(
        method,
        method === "sessions.search"
          ? { query: "needle", ...(sessionKeys ? { sessionKeys } : {}) }
          : { keys: ["agent:main:first"] },
        opts,
      );
      expect(after).toMatchObject({
        ok: true,
        payload:
          method === "sessions.search"
            ? { results: [expect.objectContaining({ sessionKey: "agent:main:second" })] }
            : { previews: [{ key: "agent:main:first", status: "missing", items: [] }] },
      });
    });
  },
);

test.each([
  {
    change: "an unread row becoming draft",
    key: "agent:main:second",
    patch: { visibility: "draft" },
    visible: false,
  },
  {
    change: "a buffered row becoming draft",
    key: "agent:main:first",
    patch: { visibility: "draft" },
    visible: false,
  },
  {
    change: "a buffered row becoming incognito",
    key: "agent:main:first",
    patch: { incognito: true },
    visible: false,
  },
  {
    change: "a buffered row receiving a replacement session",
    key: "agent:main:first",
    patch: { sessionId: "replacement-session" },
    visible: false,
  },
  {
    change: "a buffered row receiving a replacement lifecycle",
    key: "agent:main:first",
    patch: { lifecycleRevision: "replacement-lifecycle" },
    visible: false,
  },
  {
    change: "a buffered row receiving an ordinary metadata update",
    key: "agent:main:first",
    patch: { label: "Renamed session" },
    visible: true,
  },
  {
    change: "the caller role losing other-session access",
    key: undefined,
    visible: false,
    restrict: "profile",
  },
  {
    change: "the runtime configuration losing other-session access",
    key: undefined,
    visible: false,
    restrict: "config",
  },
] as const)("sessions.preview rechecks $change before publishing the batch", async (scenario) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { opts, storePath, viewerId, restrictRuntimeConfig } = await seedMetadataReads(true);
    const firstRead = createDeferred();
    const read = transcriptPreview.readSessionPreviewItemsFromTranscriptAsync;
    vi.spyOn(transcriptPreview, "readSessionPreviewItemsFromTranscriptAsync").mockImplementation(
      async (...args) => {
        const result = await read(...args);
        if (args[0].sessionKey === "agent:main:first") {
          firstRead.resolve();
        }
        return result;
      },
    );
    const keys = ["agent:main:first", "agent:main:second"];
    const pending = directSessionReq("sessions.preview", { keys }, opts);
    await firstRead.promise;
    if ("restrict" in scenario) {
      if (scenario.restrict === "profile") {
        setUserProfileRole(viewerId, "restricted");
        invalidateOperatorRolePolicy(viewerId);
      } else {
        restrictRuntimeConfig();
      }
    } else {
      const scope = { agentId: "main", sessionKey: scenario.key, storePath };
      const entry = loadSessionEntryReadOnly(scope);
      if (!entry) {
        throw new Error(`Missing seeded session ${scenario.key}`);
      }
      replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, ...scenario.patch });
    }
    expect(await pending).toMatchObject({
      ok: true,
      payload: {
        previews: keys.map((previewKey) =>
          !scenario.visible && (scenario.key === undefined || previewKey === scenario.key)
            ? { key: previewKey, status: "missing", items: [] }
            : {
                key: previewKey,
                status: "ok",
                items: [
                  {
                    role: "user",
                    text:
                      previewKey === "agent:main:first"
                        ? "needle alpha"
                        : expect.stringContaining("needle beta"),
                  },
                ],
              },
        ),
      },
    });
  });
});
