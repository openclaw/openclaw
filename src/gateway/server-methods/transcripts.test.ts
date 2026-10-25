import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIPTS_RESULT_MAX_BYTES } from "../../../packages/gateway-protocol/src/schema/transcripts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTranscriptCaptureAppends } from "../../transcripts/capture-appends.js";
import { activeSessions } from "../../transcripts/capture-startup.js";
import { startTranscripts } from "../../transcripts/capture.js";
import { clearTranscriptCapturesForTest } from "../../transcripts/capture.test-support.js";
import * as transcriptProviders from "../../transcripts/provider-registry.js";
import {
  deriveMeetingTranscriptSessionColumns,
  deriveMeetingTranscriptSummaryColumns,
} from "../../transcripts/store-columns.js";
import { meetingTranscriptDb } from "../../transcripts/store-sqlite.js";
import { TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { summarizeTranscripts, type TranscriptsSummary } from "../../transcripts/summary.js";
import type { OperatorScope } from "../operator-scopes.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { transcriptsHandlers } from "./transcripts.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});
const logGateway = { warn: vi.fn() };

function client(profileId?: string, scopes = ["operator.read"]): GatewayClient {
  return {
    connect: gatewayConnect(scopes),
    ...(profileId ? { authenticatedUserProfile: gatewayProfile(profileId) } : {}),
  };
}
function roles(
  others: "none" | "view",
  scopes: OperatorScope[] = ["operator.read"],
): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "limited",
        definitions: {
          limited: { sessions: { others }, agents: ["main"], scopes },
        },
      },
    },
  };
}
async function request(
  method: string,
  params: Record<string, unknown> = {},
  cfg: OpenClawConfig = {},
  caller = client(),
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: "transcript-read", method, params },
    respond,
    client: caller,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => cfg,
      logGateway,
    } as unknown as GatewayRequestContext,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond.mock.calls[0]!;
}
async function directRequest(
  method: string,
  params: Record<string, unknown>,
  options: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn();
  await transcriptsHandlers[method]!({
    req: { type: "req", id: "test", method },
    params,
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: { getRuntimeConfig: () => ({}), logGateway } as unknown as GatewayRequestContext,
    ...options,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]!;
}
async function succeeds(...args: Parameters<typeof request>) {
  const [ok, payload] = await request(...args);
  expect(ok).toBe(true);
  return payload;
}
async function fails(...args: Parameters<typeof request>) {
  const [ok, payload, error] = await request(...args);
  expect(ok).toBe(false);
  expect(payload).toBeUndefined();
  return error;
}
function afterRead<T extends (...args: never[]) => Promise<unknown>>(
  read: T,
  after: () => void,
): T {
  return new Proxy(read, {
    async apply(target, receiver, args) {
      const result = await Reflect.apply(target, receiver, args);
      after();
      return result;
    },
  });
}
async function seed(stateDir: string) {
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
  const session = {
    sessionId: "meeting",
    source: { providerId: "manual-transcript" },
    startedAt: "2026-08-20T10:00:00.000Z",
    metadata: { agentId: "ops" },
  };
  await store.writeSession(session);
  await store.appendUtteranceForSession(session, { text: "Archive-only text", final: true });
  return { store, session, selector: transcriptSessionSelector(session) };
}

describe("transcript Gateway read authorization and errors", () => {
  it("requires write scope and archive visibility to generate notes", async () => {
    await withOpenClawTestState(profileState, async (state) => {
      const { selector, store, session } = await seed(state.stateDir);
      const writer = client(undefined, ["operator.write"]);
      await fails("transcripts.summarize", { selector });
      await fails("transcripts.summarize", { selector }, roles("none"), writer);
      expect((await store.readSummary(session)).summary).toBeUndefined();
      await succeeds("transcripts.summarize", { selector }, {}, writer);
      expect((await store.readSummary(session)).summary).toBeDefined();
    });
  });

  beforeEach(() => {
    logGateway.warn.mockClear();
    vi.spyOn(transcriptProviders, "getTranscriptSourceProvider").mockReturnValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("maps archive byte-limit failures to explicit RPC errors without partial output", async () => {
    await withOpenClawTestState(profileState, async (state) => {
      const { store, session, selector } = await seed(state.stateDir);
      await store.appendUtteranceForSession(session, {
        text: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1),
      });
      expect(
        await fails("transcripts.get", { selector, includeUtterances: true, limit: 50 }),
      ).toMatchObject({
        code: "INVALID_REQUEST",
        details: { type: "transcript_result_too_large", maxBytes: TRANSCRIPTS_RESULT_MAX_BYTES },
      });
      expect(fs.existsSync(path.join(state.stateDir, "transcripts"))).toBe(false);
    });
  });

  it("keeps configured capture intent out of RPC results and durable session metadata", async () => {
    await withOpenClawTestState(profileState, async (state) => {
      const source = { providerId: "fixture-voice", channelId: "room" };
      const cfg = { transcripts: { autoStart: [source] } };
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const registry = createEmptyPluginRegistry();
      registry.transcriptSourceProviders.push({
        pluginId: "transcript-test-fixture",
        source: import.meta.url,
        provider: {
          id: source.providerId,
          name: "Fixture voice",
          sourceKinds: ["live-audio"],
          accessControl: {
            channelId: "discord",
            resolveAccountId: () => ({ ok: true, value: "default" }),
            authorize: async () => ({ ok: true, value: undefined }),
          },
          start: async ({ session }) => ({ ok: true, session }),
        },
      });
      setActivePluginRegistry(registry);
      try {
        const store = new TranscriptsStore(path.join(state.stateDir, "transcripts"));
        await startTranscripts({
          ctx: { config: cfg, stateDir: state.stateDir, logger: { warn: vi.fn() } },
          store,
          rawParams: { ...source, sessionId: "configured-capture" },
          configuredLifecycle: true,
        });
        const payload = await succeeds("transcripts.status", {}, cfg);
        expect(payload).toMatchObject({
          configuredSources: [{ state: "armed" }],
          active: [{ source: { accountId: "default" }, activeSubscription: true }],
        });
        expect(JSON.stringify(payload)).not.toContain('configuredSource"');
        expect(JSON.stringify(await store.readSession("configured-capture"))).not.toContain(
          "configuredSource",
        );
      } finally {
        restoreActivePluginRegistrySnapshot(previousRegistry);
        await clearTranscriptCapturesForTest();
      }
    });
  });

  it("denies every global archive read for sessions.others:none even with allowed or forged agent filters", async () => {
    await withOpenClawTestState(profileState, async (state) => {
      const { selector } = await seed(state.stateDir);
      const profile = ensureProfileForEmail("transcript-guest@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const cfg = roles("none");
      const queries: Array<[string, Record<string, unknown>]> = [
        ["transcripts.list", {}],
        ["transcripts.list", { agentId: "main" }],
        ["transcripts.list", { agentId: "ops" }],
        ["transcripts.get", { selector }],
        ["transcripts.export", { selector, format: "jsonl" }],
        ["transcripts.status", {}],
      ];
      for (const [method, params] of queries) {
        expect(await fails(method, params, cfg, client(profile.id))).toMatchObject({
          code: "FORBIDDEN",
        });
      }
      expect((await request("transcripts.list", {}, cfg, client()))[2]).toMatchObject({
        code: "FORBIDDEN",
      });
      expect(fs.existsSync(path.join(state.stateDir, "transcripts"))).toBe(false);
    });
  });

  it("preserves global reads for view roles and admins without treating the creation agent allowlist as read scope", async () => {
    await withOpenClawTestState(profileState, async (state) => {
      const { selector } = await seed(state.stateDir);
      const profile = ensureProfileForEmail("transcript-reader@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const caller = client(profile.id);
      const cfg = roles("view");
      const payload = await succeeds("transcripts.list", { agentId: "ops" }, cfg, caller);
      expect(payload).toMatchObject({
        sessions: [{ selector, agentId: "ops", utteranceCount: 1 }],
      });
      await succeeds("transcripts.get", { selector }, cfg, caller);
      const exported = await succeeds(
        "transcripts.export",
        { selector, format: "jsonl" },
        cfg,
        caller,
      );
      expect(exported).toMatchObject({ encoding: "base64", selector });
      await succeeds(
        "transcripts.list",
        {},
        roles("none", ["operator.admin"]),
        client(profile.id, ["operator.admin"]),
      );
      expect(
        await fails("transcripts.get", { selector, agentId: "main" }, cfg, caller),
      ).toMatchObject({ code: "INVALID_REQUEST" });
      expect(fs.existsSync(path.join(state.stateDir, "transcripts"))).toBe(false);
    });
  });

  it("uses the normal operator role and scope fence and never advertises a capture mutation method", async () => {
    await withOpenClawTestState(profileState, async () => {
      for (const [method, params] of [
        ["transcripts.list", {}],
        ["transcripts.get", { selector: "missing" }],
        ["transcripts.export", { selector: "missing", format: "markdown" }],
        ["transcripts.status", {}],
      ] as const) {
        const denied = await request(method, params, {}, client(undefined, ["operator.questions"]));
        expect(denied[0]).toBe(false);
        expect(denied[2]?.details).toMatchObject({ missingScope: "operator.read" });
        const node = client(undefined, ["operator.admin"]);
        node.connect.role = "node";
        expect((await request(method, params, {}, node))[2]).toMatchObject({
          code: "INVALID_REQUEST",
          message: "unauthorized role: node",
        });
      }
      await fails("transcripts.start", {}, {}, client(undefined, ["operator.admin"]));
      await succeeds("transcripts.list", {}, {}, client(undefined, ["operator.write"]));
    });
  });

  it.each(["authority", "archive role", "cancellation"])(
    "refuses a public page after %s changes during its worker read",
    async (kind) => {
      await withOpenClawTestState(profileState, async (state) => {
        const { store } = await seed(state.stateDir);
        const profile = ensureProfileForEmail("public-page-reader@example.test");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const cancellation = new AbortController();
        let current = true;
        const cfg = roles("view");
        const observer = vi
          .spyOn(TranscriptsStore.prototype, "listReadEntries")
          .mockImplementationOnce(
            afterRead(store.listReadEntries.bind(store), () => {
              current = false;
              if (kind === "cancellation") {
                cancellation.abort();
              }
            }),
          );
        try {
          const response = await directRequest(
            "transcripts.list",
            {},
            {
              client: client(profile.id),
              signal: cancellation.signal,
              hasCurrentClientAuthority: () => kind !== "authority" || current,
              context: {
                getRuntimeConfig: () => (kind === "archive role" && !current ? roles("none") : cfg),
                logGateway,
              } as unknown as GatewayRequestContext,
            },
          );
          expect(observer).toHaveBeenCalledOnce();
          expect(response).toEqual([
            false,
            undefined,
            expect.objectContaining({ code: "UNAVAILABLE" }),
          ]);
        } finally {
          observer.mockRestore();
        }
      });
    },
  );

  it("rejects invalid requests and missing selectors, and redacts archive failures", async () => {
    await withOpenClawTestState(profileState, async (state) => {
      const { session, selector } = await seed(state.stateDir);
      for (const [method, params] of [
        ["transcripts.list", { limit: 201 }],
        ["transcripts.list", { query: "x".repeat(257) }],
        ["transcripts.list", { startedAfter: "not-a-date" }],
        ["transcripts.get", { selector, limit: 0 }],
        ["transcripts.export", { selector, format: "audio" }],
        ["transcripts.status", { enabled: false }],
      ] as const) {
        expect((await request(method, params))[2]).toMatchObject({ code: "INVALID_REQUEST" });
      }
      for (const method of ["transcripts.get", "transcripts.export"]) {
        const params = {
          selector: "missing",
          ...(method.endsWith("export") ? { format: "jsonl" } : {}),
        };
        expect((await request(method, params))[2]).toMatchObject({
          code: "INVALID_REQUEST",
          details: { type: "transcript_session_not_found" },
        });
      }
      expect(logGateway.warn).not.toHaveBeenCalled();
      const { db } = openOpenClawStateDatabase();
      const corruptSource = "private corrupt source /host/private/path";
      executeSqliteQuerySync(
        db,
        meetingTranscriptDb(db)
          .updateTable("meeting_transcript_sessions")
          .set({
            source_json: corruptSource,
            ...deriveMeetingTranscriptSessionColumns(
              corruptSource,
              JSON.stringify(session.metadata),
            ),
          })
          .where("session_id", "=", session.sessionId),
      );
      const result = await request("transcripts.get", { selector });
      expect(result[2]).toMatchObject({ code: "UNAVAILABLE" });
      expect(JSON.stringify(result)).not.toContain("/host/private/path");
      expect(logGateway.warn).toHaveBeenCalledWith(
        expect.stringMatching(/transcripts\.get failed: SyntaxError/),
      );
    });
  });
});

describe("meeting transcript RPC", () => {
  let store: TranscriptsStore;

  const session = {
    sessionId: "weekly",
    startedAt: "2026-08-02T14:00:00.000Z",
    source: { providerId: "manual-transcript" },
  };

  const selector = transcriptSessionSelector(session);

  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState(profileState);
    const stateDir = state.stateDir;
    vi.spyOn(transcriptProviders, "getTranscriptSourceProvider").mockReturnValue(undefined);
    store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await store.writeSession(session);
  });
  afterEach(async () => {
    await clearTranscriptCapturesForTest();
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it("generates missing notes once for concurrent opens and preserves them on later opens", async () => {
    await store.appendUtteranceForSession(session, { text: "Decision: ship the meeting reader." });
    const writes = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
    const [first, second] = await Promise.all([
      directRequest("transcripts.summarize", { selector }),
      directRequest("transcripts.summarize", { selector }),
    ]);
    expect(first[0]).toBe(true);
    expect(second[0]).toBe(true);
    expect(first[1].summary.overview).toContain("ship the meeting reader");
    expect(second[1].summary).toEqual(first[1].summary);
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await directRequest("transcripts.summarize", { selector }))[1].summary).toEqual(
      first[1].summary,
    );
    expect(writes).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(store.sessionDir(session))).toBe(false);
  });

  it.each(["snapshot", "response"] as const)(
    "does not return notes when requester authority expires during %s",
    async (phase) => {
      await store.appendUtteranceForSession(session, { text: "Agreed to ship." });
      let current = true;
      if (phase === "snapshot") {
        vi.spyOn(TranscriptsStore.prototype, "readSummarySnapshot").mockImplementation(
          afterRead(store.readSummarySnapshot.bind(store), () => {
            current = false;
          }),
        );
      } else {
        let reads = 0;
        vi.spyOn(TranscriptsStore.prototype, "readLibraryEntry").mockImplementation(
          afterRead(store.readLibraryEntry.bind(store), () => {
            if (++reads === 2) {
              current = false;
            }
          }),
        );
      }
      const response = await directRequest(
        "transcripts.summarize",
        { selector },
        {
          hasCurrentClientAuthority: () => current,
        },
      );
      expect(response).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      ]);
      if (phase === "snapshot") {
        expect((await store.readSummary(session)).summary).toBeUndefined();
      }
    },
  );

  it.each([{ texts: [] }, { texts: ["context:", "###", "Transcribe the audio."] }])(
    "leaves meetings without substantive speech unsummarized: %j",
    async ({ texts }) => {
      for (const text of texts) {
        await store.appendUtteranceForSession(session, { text });
      }
      expect(await directRequest("transcripts.summarize", { selector })).toMatchObject([
        true,
        { session: { hasSummary: false, utteranceCount: texts.length } },
      ]);
      expect((await store.readSummary(session)).summary).toBeUndefined();
    },
  );

  it("lists first-appearance speakers, model attribution, and live capture state", async () => {
    for (const label of ["Zoe", "Ada", "Zoe"]) {
      await store.appendUtteranceForSession(session, { text: "Agreed.", speaker: { label } });
    }
    await store.appendUtteranceForSession(session, { text: "Unattributed" });
    const storedSummary = {
      ...summarizeTranscripts({ session, utterances: [] }),
      source: "model",
      participants: ["Zoe", "Ada"],
      model: "gpt-5.6-luna",
    } satisfies TranscriptsSummary;
    await store.writeSummary(storedSummary, session);
    activeSessions.set(session.sessionId, {
      appends: createTranscriptCaptureAppends(() => {}),
      session,
      providerId: "manual-transcript",
      stopProvider: async () => {
        throw new Error("Listing transcripts must not stop capture");
      },
      releaseProvider: async () => {},
      phase: "active",
    });
    const [ok, payload] = await directRequest("transcripts.list", {});
    expect(ok).toBe(true);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({
      utteranceCount: 4,
      participants: ["Zoe", "Ada"],
      active: true,
      hasSummary: true,
      summarySource: "model",
    });
  });

  it("reads older stored notes without participant or model attribution fields", async () => {
    const summary = summarizeTranscripts({ session, utterances: [{ text: "Legacy notes." }] });
    await store.writeSummary(summary, session);
    const database = openOpenClawStateDatabase().db;
    const summaryJson = JSON.stringify({ ...summary, participants: undefined, source: undefined });
    executeSqliteQuerySync(
      database,
      meetingTranscriptDb(database)
        .updateTable("meeting_transcript_summaries")
        .set({
          summary_json: summaryJson,
          ...deriveMeetingTranscriptSummaryColumns(summaryJson),
        })
        .where("session_id", "=", session.sessionId)
        .where("session_started_at", "=", session.startedAt),
    );
    const [ok, payload] = await directRequest("transcripts.get", {
      selector: transcriptSessionSelector(session),
    });
    expect(ok).toBe(true);
    expect(payload.summary).toMatchObject({ overview: "Legacy notes.", participants: [] });
    expect(payload.summary.source).toBeUndefined();
    expect(payload.summary.model).toBeUndefined();
  });
});
