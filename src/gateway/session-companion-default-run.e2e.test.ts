import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import {
  listSessionEntryKeysReadOnly,
  loadExactSessionEntry,
  loadExactSessionEntryCandidates,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";
import {
  runSessionCompanionDefault,
  SessionCompanionAskError,
  type SessionCompanionRunParams,
} from "./session-companion-run.js";
import { createSessionCompanion } from "./session-companion.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

type RequestObservation = {
  databaseExisted: boolean;
  databasePath: string;
  sessionId: string;
  sessionKey: string;
};

type MockOpenAiServer = {
  baseUrl: string;
  requestBodies: string[];
  requestPaths: string[];
  observations: RequestObservation[];
  close: () => Promise<void>;
};

type MockOpenAiServerParams = {
  answer: string;
  storePath: string;
  onRequest?: () => Promise<void> | void;
  firstRequestEvents?: readonly Record<string, unknown>[];
};

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  closeOpenClawAgentDatabasesForTest();
});

function createConfig(params: {
  baseUrl: string;
  storePath: string;
  workspaceDir: string;
  roles?: boolean;
}): OpenClawConfig {
  return {
    ...(params.roles ? rolePolicyConfig() : {}),
    session: { store: params.storePath },
    plugins: { enabled: false },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        utilityModel: "loopback/side-chat-model",
        skipBootstrap: true,
        skills: [],
      },
      list: [{ id: "main" }],
    },
    models: {
      mode: "replace",
      providers: {
        loopback: {
          baseUrl: `${params.baseUrl}/v1`,
          apiKey: "test",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "side-chat-model",
              name: "Side Chat loopback model",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 256,
            },
          ],
        },
      },
    },
  };
}

function directRunParams(params: {
  authorize: () => boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  workspaceDir: string;
}): SessionCompanionRunParams {
  return {
    cfg: params.cfg,
    agentId: "main",
    modelRef: "loopback/side-chat-model",
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    systemPrompt: "Answer the Side Chat question with the configured response.",
    messages: [{ role: "user", content: "What is the current status?", ts: 1 }],
    authorize: params.authorize,
    signal: new AbortController().signal,
  };
}

async function internalSessionKeys(storePath: string): Promise<string[]> {
  return (await listSessionEntryKeysReadOnly({ agentId: "main", storePath })).filter(
    isInternalSessionEffectsKey,
  );
}

async function startMockOpenAiServer(params: MockOpenAiServerParams): Promise<MockOpenAiServer> {
  const requestBodies: string[] = [];
  const requestPaths: string[] = [];
  const observations: RequestObservation[] = [];
  const server = createServer((request, response) => {
    void handleMockOpenAiRequest({
      ...params,
      observations,
      request,
      requestBodies,
      requestPaths,
      response,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock OpenAI server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestBodies,
    requestPaths,
    observations,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleMockOpenAiRequest(
  params: MockOpenAiServerParams & {
    observations: RequestObservation[];
    request: IncomingMessage;
    requestBodies: string[];
    requestPaths: string[];
    response: ServerResponse;
  },
): Promise<void> {
  const url = new URL(params.request.url ?? "/", "http://127.0.0.1");
  if (params.request.method !== "POST" || url.pathname !== "/v1/responses") {
    params.response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of params.request) {
    body += String(chunk);
  }
  params.requestBodies.push(body);
  params.requestPaths.push(url.pathname);

  const [sessionKey] = await internalSessionKeys(params.storePath);
  if (!sessionKey) {
    params.response.writeHead(500).end("temporary session was not present during dispatch");
    return;
  }
  let databasePath = "";
  const [persisted] = loadExactSessionEntryCandidates({
    agentId: "main",
    storePath: params.storePath,
    sessionKeys: [sessionKey],
    readOnly: false,
    onReadSource: (source) => {
      databasePath = source.path;
    },
  });
  if (!persisted || !databasePath) {
    params.response.writeHead(500).end("temporary session was not persisted during dispatch");
    return;
  }
  params.observations.push({
    databaseExisted: fs.existsSync(databasePath),
    databasePath,
    sessionId: persisted.entry.sessionId,
    sessionKey,
  });

  await params.onRequest?.();
  if (params.firstRequestEvents && params.requestBodies.length === 1) {
    writeOpenAiResponsesSse(params.response, params.firstRequestEvents);
    return;
  }
  writeOpenAiResponsesText(params.response, {
    text: params.answer,
    messageId: "side-chat-message",
    responseId: "side-chat-response",
  });
}

async function persistBackingSession(params: {
  ownerId: string;
  sessionId: string;
  sessionKey: string;
  visibility: "draft" | "shared";
}): Promise<void> {
  const scope = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
  await upsertSessionEntryCore(scope, {
    sessionId: params.sessionId,
    updatedAt: 1,
    visibility: params.visibility,
    createdActor: { type: "human", source: "profile", id: params.ownerId },
  });
  await persistSessionTranscriptTurn(scope, {
    messages: [
      {
        eventId: `${params.sessionId}-context`,
        parentId: null,
        message: { role: "user", content: "STATUS_CONTEXT=ready", timestamp: 1 },
      },
    ],
    touchSessionEntry: true,
  });
}

async function expectCleanedTemporarySession(
  server: MockOpenAiServer,
  storePath: string,
): Promise<void> {
  expect(server.observations).toHaveLength(1);
  const observation = server.observations[0];
  expect(observation).toBeDefined();
  expect(observation?.databaseExisted).toBe(true);
  expect(fs.existsSync(observation?.databasePath ?? "")).toBe(true);
  expect(
    observation
      ? loadExactSessionEntry({
          agentId: "main",
          sessionKey: observation.sessionKey,
          storePath,
        })
      : undefined,
  ).toBeUndefined();
  expect(await internalSessionKeys(storePath)).toEqual([]);
}

describe("session companion default production run", () => {
  it("dispatches an allowed owner draft ask and removes its real temporary session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const server = await startMockOpenAiServer({
        answer: "The session is ready.",
        storePath,
      });
      cleanupTasks.push(server.close);
      const cfg = createConfig({
        baseUrl: server.baseUrl,
        roles: true,
        storePath,
        workspaceDir: state.workspaceDir,
      });
      const owner = ensureProfileForEmail("draft-owner@example.test");
      const sessionKey = "agent:main:owner-draft";
      await persistBackingSession({
        ownerId: owner.id,
        sessionId: "owner-draft-session",
        sessionKey,
        visibility: "draft",
      });

      const entryBefore = loadExactSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
      });
      const ownerClient = roleClient("view", "draft-owner");
      ownerClient.connId = "draft-owner-connection";
      const service = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
        run: runSessionCompanionDefault,
      });
      const respond = vi.fn();
      try {
        await sessionCompanionHandlers["sessions.companion.ask"]?.({
          params: { sessionKey, question: "What is the current status?" },
          client: ownerClient,
          context: {
            sessionCompanion: service,
            getRuntimeConfig: () => cfg,
            isConnectionActive: () => true,
          },
          respond,
        } as never);

        expect(respond).toHaveBeenCalledWith(true, {
          answer: "The session is ready.",
          ts: expect.any(Number),
        });
        expect(server.requestPaths).toEqual(["/v1/responses"]);
        expect(server.requestBodies).toHaveLength(1);
        expect(JSON.parse(server.requestBodies[0] ?? "{}")).toMatchObject({
          model: "side-chat-model",
        });

        const entryAfter = loadExactSessionEntry({
          agentId: "main",
          sessionKey,
          storePath,
        });
        expect(JSON.stringify(entryAfter)).toEqual(JSON.stringify(entryBefore));
        expect(JSON.stringify(entryAfter)).not.toMatch(/assertRunAuthorization|"authorize"/);
        await expectCleanedTemporarySession(server, storePath);
      } finally {
        service.dispose();
      }
    });
  });

  it("preserves a prior-release session entry and authorized owner access across the upgrade", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const server = await startMockOpenAiServer({
        answer: "The session is ready.",
        storePath,
      });
      cleanupTasks.push(server.close);
      const cfg = createConfig({
        baseUrl: server.baseUrl,
        roles: true,
        storePath,
        workspaceDir: state.workspaceDir,
      });
      const owner = ensureProfileForEmail("upgrade-owner@example.test");
      const sessionKey = "agent:main:upgrade-owner";
      await persistBackingSession({
        ownerId: owner.id,
        sessionId: "upgrade-owner-session",
        sessionKey,
        visibility: "draft",
      });

      // The persisted schema is unchanged by this PR: this entry holds only
      // the fields a prior release (v2026.9.4) wrote, so the run below starts
      // from prior-release-shaped data loaded by the new code.
      const entryBefore = loadExactSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
      });

      const ownerClient = roleClient("view", "upgrade-owner");
      ownerClient.connId = "upgrade-owner-connection";
      const service = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
        run: runSessionCompanionDefault,
      });
      const respond = vi.fn();
      try {
        await sessionCompanionHandlers["sessions.companion.ask"]?.({
          params: { sessionKey, question: "What is the current status?" },
          client: ownerClient,
          context: {
            sessionCompanion: service,
            getRuntimeConfig: () => cfg,
            isConnectionActive: () => true,
          },
          respond,
        } as never);

        expect(respond).toHaveBeenCalledWith(true, {
          answer: "The session is ready.",
          ts: expect.any(Number),
        });
        expect(server.requestPaths).toEqual(["/v1/responses"]);

        // Existing data is preserved across the upgrade: the run with active
        // authorization callbacks persists nothing new into the store.
        const entryAfter = loadExactSessionEntry({
          agentId: "main",
          sessionKey,
          storePath,
        });
        expect(JSON.stringify(entryAfter)).toEqual(JSON.stringify(entryBefore));
        expect(JSON.stringify(entryAfter)).not.toMatch(/assertRunAuthorization|"authorize"/);
        await expectCleanedTemporarySession(server, storePath);
      } finally {
        service.dispose();
      }
    });
  });

  it("rejects a forbidden caller before provider dispatch or temporary-session creation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const server = await startMockOpenAiServer({ answer: "Must not dispatch.", storePath });
      cleanupTasks.push(server.close);
      const cfg = createConfig({
        baseUrl: server.baseUrl,
        storePath,
        workspaceDir: state.workspaceDir,
      });

      await expect(
        runSessionCompanionDefault(
          directRunParams({
            authorize: () => false,
            cfg,
            sessionKey: "agent:main:forbidden",
            workspaceDir: state.workspaceDir,
          }),
        ),
      ).rejects.toMatchObject<Partial<SessionCompanionAskError>>({
        name: "SessionCompanionAskError",
        reason: "session-missing",
      });
      expect(server.requestBodies).toEqual([]);
      expect(server.observations).toEqual([]);
      expect(await internalSessionKeys(storePath)).toEqual([]);
    });
  });

  it("withholds a dispatched answer after authorization is revoked and removes the temporary session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      let authorized = true;
      const server = await startMockOpenAiServer({
        answer: "Must not be returned.",
        storePath,
        onRequest: () => {
          authorized = false;
        },
      });
      cleanupTasks.push(server.close);
      const cfg = createConfig({
        baseUrl: server.baseUrl,
        storePath,
        workspaceDir: state.workspaceDir,
      });

      await expect(
        runSessionCompanionDefault(
          directRunParams({
            authorize: () => authorized,
            cfg,
            sessionKey: "agent:main:revoked",
            workspaceDir: state.workspaceDir,
          }),
        ),
      ).rejects.toMatchObject<Partial<SessionCompanionAskError>>({
        name: "SessionCompanionAskError",
        reason: "session-missing",
      });
      expect(server.requestPaths).toEqual(["/v1/responses"]);
      expect(server.requestBodies).toHaveLength(1);
      await expectCleanedTemporarySession(server, storePath);
    });
  });

  it("preserves authorized access for role-enabled persisted shared sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const server = await startMockOpenAiServer({
        answer: "Shared session access is preserved.",
        storePath,
      });
      cleanupTasks.push(server.close);
      const cfg = createConfig({
        baseUrl: server.baseUrl,
        roles: true,
        storePath,
        workspaceDir: state.workspaceDir,
      });
      const owner = ensureProfileForEmail("shared-owner@example.test");
      const sessionKey = "agent:main:shared-session";
      await persistBackingSession({
        ownerId: owner.id,
        sessionId: "shared-session",
        sessionKey,
        visibility: "shared",
      });
      const viewer = roleClient("view", "shared-viewer");
      viewer.connId = "shared-viewer-connection";
      const service = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
        run: runSessionCompanionDefault,
      });
      const respond = vi.fn();
      try {
        await sessionCompanionHandlers["sessions.companion.ask"]?.({
          params: { sessionKey, question: "Can I still read this shared session?" },
          client: viewer,
          context: {
            sessionCompanion: service,
            getRuntimeConfig: () => cfg,
            isConnectionActive: () => true,
          },
          respond,
        } as never);

        expect(respond).toHaveBeenCalledWith(true, {
          answer: "Shared session access is preserved.",
          ts: expect.any(Number),
        });
        expect(server.requestPaths).toEqual(["/v1/responses"]);
        expect(server.requestBodies).toHaveLength(1);
        await expectCleanedTemporarySession(server, storePath);
      } finally {
        service.dispose();
      }
    });
  });

  it("denies a foreign draft ask through the real RPC policy before provider dispatch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const server = await startMockOpenAiServer({ answer: "Must not dispatch.", storePath });
      cleanupTasks.push(server.close);
      const cfg = createConfig({
        baseUrl: server.baseUrl,
        roles: true,
        storePath,
        workspaceDir: state.workspaceDir,
      });
      const owner = ensureProfileForEmail("private-owner@example.test");
      const sessionKey = "agent:main:foreign-draft";
      await persistBackingSession({
        ownerId: owner.id,
        sessionId: "foreign-draft-session",
        sessionKey,
        visibility: "draft",
      });
      const foreignViewer = roleClient("view", "foreign-viewer");
      foreignViewer.connId = "foreign-viewer-connection";
      const service = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
        run: runSessionCompanionDefault,
      });
      const respond = vi.fn();
      try {
        await sessionCompanionHandlers["sessions.companion.ask"]?.({
          params: { sessionKey, question: "What is the current status?" },
          client: foreignViewer,
          context: {
            sessionCompanion: service,
            getRuntimeConfig: () => cfg,
            isConnectionActive: () => true,
          },
          respond,
        } as never);

        expect(respond).toHaveBeenCalledTimes(1);
        const [ok, , error] = respond.mock.calls[0] ?? [];
        expect(ok).toBe(false);
        expect(error).toMatchObject({ code: "INVALID_REQUEST" });
        expect(server.requestBodies).toEqual([]);
        expect(server.observations).toEqual([]);
        expect(await internalSessionKeys(storePath)).toEqual([]);
      } finally {
        service.dispose();
      }
    });
  });

  it("withholds a policy-revoked shared ask through the real RPC path and removes the temporary session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const server = await startMockOpenAiServer({
        answer: "Must not be returned.",
        storePath,
        onRequest: async () => {
          await upsertSessionEntryCore(
            {
              agentId: "main",
              sessionKey: "agent:main:policy-revoked",
            },
            {
              sessionId: "policy-revoked-session",
              updatedAt: 2,
              visibility: "draft",
              createdActor: {
                type: "human",
                source: "profile",
                id: ensureProfileForEmail("policy-revoked-owner@example.test").id,
              },
            },
          );
        },
      });
      cleanupTasks.push(server.close);
      const cfg = createConfig({
        baseUrl: server.baseUrl,
        roles: true,
        storePath,
        workspaceDir: state.workspaceDir,
      });
      const owner = ensureProfileForEmail("policy-revoked-owner@example.test");
      const sessionKey = "agent:main:policy-revoked";
      await persistBackingSession({
        ownerId: owner.id,
        sessionId: "policy-revoked-session",
        sessionKey,
        visibility: "shared",
      });
      const viewer = roleClient("view", "policy-revoked-viewer");
      viewer.connId = "policy-revoked-viewer-connection";
      const service = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
        run: runSessionCompanionDefault,
      });
      const respond = vi.fn();
      try {
        await sessionCompanionHandlers["sessions.companion.ask"]?.({
          params: { sessionKey, question: "What is the current status?" },
          client: viewer,
          context: {
            sessionCompanion: service,
            getRuntimeConfig: () => cfg,
            isConnectionActive: () => true,
          },
          respond,
        } as never);

        expect(server.requestPaths).toEqual(["/v1/responses"]);
        expect(server.requestBodies).toHaveLength(1);
        expect(respond).toHaveBeenCalledTimes(1);
        const [ok, , error] = respond.mock.calls[0] ?? [];
        expect(ok).toBe(false);
        expect(error).toMatchObject({
          code: "UNAVAILABLE",
          details: expect.objectContaining({ reason: "session-missing" }),
        });
        await expectCleanedTemporarySession(server, storePath);
      } finally {
        service.dispose();
      }
    });
  });

  it("suppresses queued provider I/O after persisted revocation through the real transport", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const revokedSessionScope = {
        agentId: "main",
        sessionId: "queued-revoked-session",
        sessionKey: "agent:main:queued-revoked",
      };
      const server = await startMockOpenAiServer({
        answer: "Must not be returned.",
        storePath,
        onRequest: async () => {
          await upsertSessionEntryCore(revokedSessionScope, {
            sessionId: revokedSessionScope.sessionId,
            updatedAt: 2,
            visibility: "draft",
            createdActor: {
              type: "human",
              source: "profile",
              id: ensureProfileForEmail("queued-revoked-owner@example.test").id,
            },
          });
        },
        firstRequestEvents: [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_read",
              call_id: "call_read",
              name: "read",
              arguments: '{"path": "notes.txt"}',
              status: "in_progress",
            },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_read",
              call_id: "call_read",
              name: "read",
              arguments: '{"path": "notes.txt"}',
              status: "completed",
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_tool",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: "fc_read",
                  call_id: "call_read",
                  name: "read",
                  arguments: '{"path": "notes.txt"}',
                  status: "completed",
                },
              ],
              usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
            },
          },
        ],
      });
      cleanupTasks.push(server.close);
      const cfg = createConfig({
        baseUrl: server.baseUrl,
        roles: true,
        storePath,
        workspaceDir: state.workspaceDir,
      });
      const owner = ensureProfileForEmail("queued-revoked-owner@example.test");
      await persistBackingSession({
        ownerId: owner.id,
        sessionId: revokedSessionScope.sessionId,
        sessionKey: revokedSessionScope.sessionKey,
        visibility: "shared",
      });
      const viewer = roleClient("view", "queued-revoked-viewer");
      viewer.connId = "queued-revoked-viewer-connection";
      const service = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
        run: runSessionCompanionDefault,
      });
      const respond = vi.fn();
      try {
        await sessionCompanionHandlers["sessions.companion.ask"]?.({
          params: { sessionKey: revokedSessionScope.sessionKey, question: "What is the status?" },
          client: viewer,
          context: {
            sessionCompanion: service,
            getRuntimeConfig: () => cfg,
            isConnectionActive: () => true,
          },
          respond,
        } as never);

        expect(server.requestPaths).toEqual(["/v1/responses"]);
        expect(server.requestBodies).toHaveLength(1);
        expect(respond).toHaveBeenCalledTimes(1);
        const [ok, , error] = respond.mock.calls[0] ?? [];
        expect(ok).toBe(false);
        expect(error).toMatchObject({
          code: "UNAVAILABLE",
          details: expect.objectContaining({ reason: "session-missing" }),
        });
        await expectCleanedTemporarySession(server, storePath);
      } finally {
        service.dispose();
      }
    });
  });
});
