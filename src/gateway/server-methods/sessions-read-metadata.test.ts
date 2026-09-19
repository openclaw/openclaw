import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as transcriptPreview from "../session-transcript-preview.js";
import {
  directSessionReq,
  seedLinearSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";

setupGatewaySessionsHandlerTestHarness();
afterEach(() => vi.restoreAllMocks());

const prompt = "saved prompt not needed for search or previews ".repeat(2048);
const owner = { type: "human", source: "profile", id: "owner@example.com" } as const;

async function seedMetadataReads() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  const storePath = path.join(stateDir, "shared-search.sqlite");
  const viewer = ensureProfileForEmail("viewer@example.com");
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    session: { store: storePath },
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
        },
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
  return {
    storePath,
    opts: {
      client: identifiedClient(viewer.id),
      context: { getRuntimeConfig: () => cfg },
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
      const { opts, storePath } = await seedMetadataReads();
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

test("sessions.preview rechecks visibility after yielding between keys", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { opts, storePath } = await seedMetadataReads();
    const firstRead = createDeferred();
    const read = transcriptPreview.readSessionPreviewItemsFromTranscript;
    vi.spyOn(transcriptPreview, "readSessionPreviewItemsFromTranscript").mockImplementation(
      (...args) => {
        const result = read(...args);
        if (args[0].sessionKey === "agent:main:first") {
          firstRead.resolve();
        }
        return result;
      },
    );
    const pending = directSessionReq(
      "sessions.preview",
      { keys: ["agent:main:first", "agent:main:second"] },
      opts,
    );
    await firstRead.promise;
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:second", storePath },
      { sessionId: "main-second", updatedAt: 2, createdActor: owner, visibility: "draft" },
    );
    expect(await pending).toMatchObject({
      ok: true,
      payload: {
        previews: [
          {
            key: "agent:main:first",
            status: "ok",
            items: [{ role: "user", text: "needle alpha" }],
          },
          { key: "agent:main:second", status: "missing", items: [] },
        ],
      },
    });
  });
});
