import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import * as transcriptPreview from "../session-transcript-preview.js";
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
afterEach(() => vi.restoreAllMocks());

const prompt = "saved prompt not needed for search or previews ".repeat(2048);
const owner = { type: "human", source: "profile", id: "owner@example.com" } as const;
const sessionKey = (name: string) => `agent:main:${name}`;

function expectedPreview(key: string, text?: unknown) {
  return {
    key,
    status: text === undefined ? "missing" : "ok",
    items: text === undefined ? [] : [{ role: "user", text }],
  };
}

function previewResponse(previews: ReturnType<typeof expectedPreview>[]) {
  return { ok: true, payload: { previews } };
}

async function seedMetadataReads(prepareProjection = false) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  const storePath = path.join(stateDir, "shared-search.sqlite");
  const viewer = ensureProfileForEmail("viewer@example.com");
  const role = (others: "view" | "none"): GatewayOperatorRoleDefinition => ({
    sessions: { others },
    agents: "*",
    scopes: ["operator.read"],
  });
  const definitions = { reader: role("view"), restricted: role("none") };
  let cfg: OpenClawConfig = {
    agents: { defaults: { sessionStore: { agentId: "main" } }, entries: { main: {}, work: {} } },
    session: { store: storePath },
    gateway: { roles: { default: "reader", definitions } },
  };
  setRuntimeConfigSnapshot(cfg);
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
  // Cold reads must start after the seed workers release the same physical stores.
  await closeOpenClawAgentDatabasesAsync(stateDir);
  closeOpenClawAgentDatabasesForTest(stateDir);
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
    opts: { client: identifiedClient(viewer.id), context },
  };
}

test.each([
  { method: "sessions.search", scope: "unfiltered", sessionKeys: undefined },
  {
    method: "sessions.search",
    scope: "explicit keys",
    sessionKeys: ["first", "second", "draft", "private", "missing", "first"].map(sessionKey),
  },
  { method: "sessions.preview", scope: "explicit keys", sessionKeys: undefined },
] as const)(
  "$method ($scope) retains visible results without decoding saved prompts",
  ({ method, sessionKeys }) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const { opts, storePath } = await seedMetadataReads(method === "sessions.preview");
      const request = <T = unknown>(params: Record<string, unknown>) =>
        directSessionReq<T>(method, params, opts);
      const search = { query: "needle", ...(sessionKeys ? { sessionKeys } : {}) };
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
          const all = await request<{ results: Array<{ sessionKey: string }> }>(search);
          expect(all.ok, all.error?.message).toBe(true);
          expect(all.payload?.results.map((hit) => hit.sessionKey)).toEqual(
            ["first", "second"].map(sessionKey),
          );
          expect(await request({ ...search, limit: 1 })).toMatchObject({
            ok: true,
            payload: { results: [all.payload?.results[0]], truncated: true },
          });
        } else {
          const response = await request({ keys: ["first", "draft", "private"].map(sessionKey) });
          expect(response).toMatchObject(
            previewResponse([
              expectedPreview("agent:main:first", "needle alpha"),
              expectedPreview("agent:main:draft"),
              expectedPreview("agent:main:private"),
            ]),
          );
        }
        expect(decodedPromptBytes).toBe(0);
      } finally {
        parsed.mockRestore();
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:first", storePath },
        { visibility: "draft" },
      );
      const after = await request(
        method === "sessions.search" ? search : { keys: [sessionKey("first")] },
      );
      expect(after).toMatchObject({
        ok: true,
        payload:
          method === "sessions.search"
            ? { results: [expect.objectContaining({ sessionKey: "agent:main:second" })] }
            : { previews: [expectedPreview("agent:main:first")] },
      });
    }),
);

test.each([
  ["unread draft", "second", { visibility: "draft" }, false],
  ["buffered draft", "first", { visibility: "draft" }, false],
  ["buffered incognito", "first", { incognito: true }, false],
  ["replaced session", "first", { sessionId: "replacement-session" }, false],
  ["replaced lifecycle", "first", { lifecycleRevision: "replacement-lifecycle" }, false],
  ["ordinary metadata", "first", { label: "Renamed session" }, true],
  ["profile revocation", undefined, "profile", false],
  ["config revocation", undefined, "config", false],
] as const)(
  "sessions.preview rechecks %s before publishing the batch",
  (_change, name, patch, visible) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const { opts, storePath, viewerId, restrictRuntimeConfig } = await seedMetadataReads(true);
      const key = name ? `agent:main:${name}` : undefined;
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
      if (typeof patch === "string") {
        if (patch === "profile") {
          setUserProfileRole(viewerId, "restricted");
          invalidateOperatorRolePolicy(viewerId);
        } else {
          restrictRuntimeConfig();
        }
      } else {
        const scope = { agentId: "main", sessionKey: `agent:main:${name}`, storePath };
        const entry = loadSessionEntryReadOnly(scope);
        if (!entry) {
          throw new Error(`Missing seeded session ${key}`);
        }
        replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, ...patch });
      }
      expect(await pending).toMatchObject(
        previewResponse(
          keys.map((previewKey) =>
            !visible && (key === undefined || previewKey === key)
              ? expectedPreview(previewKey)
              : expectedPreview(
                  previewKey,
                  previewKey === "agent:main:first"
                    ? "needle alpha"
                    : expect.stringContaining("needle beta"),
                ),
          ),
        ),
      );
    }),
);
