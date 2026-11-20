import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asOptionalRecord, expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { expect, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES as MODES,
  GATEWAY_CLIENT_NAMES as NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createTestOperatorAuthority } from "../../agents/admitted-run-context.test-support.js";
import { inheritLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import {
  loadExactSessionEntryCandidates,
  replaceSessionEntry,
  type SessionAccessScope,
} from "../../config/sessions/session-accessor.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  retainGatewayPluginMetadata,
  type GatewayPluginMetadataOwner,
} from "../../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { ReplyBackendHandle } from "../../sessions/session-controller.contracts.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { DedupeEntry } from "../server-shared.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { createScopedCliClient } from "./chat-client.test-support.js";
import { readChatSendDedupeResponse } from "./chat-send-reservation.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export const handedOffDashboardSession = {
  createdVia: "spawn",
  spawnedBy: "agent:main:main",
  parentSessionKey: "agent:main:main",
  spawnDepth: 1,
} as const;

/**
 * `local: "resumed"` sends the Control UI reconnect marker; admission matches a fresh send.
 * A remote `operator.admin` turn is a management turn (no configured-MCP capture), so the
 * remote and resumed cases use `operator.write`.
 */
export const lazyChatCronAuthorityCases = [
  [NAMES.CONTROL_UI, MODES.WEBCHAT, "web", "operator.admin", true],
  [NAMES.CLI, MODES.CLI, "darwin", "operator.admin", true],
  [NAMES.CONTROL_UI, MODES.WEBCHAT, "web", "operator.write", false],
  [NAMES.CONTROL_UI, MODES.WEBCHAT, "web", "operator.write", true],
  [NAMES.CONTROL_UI, MODES.WEBCHAT, "web", "operator.cron", false],
  [NAMES.CONTROL_UI, MODES.WEBCHAT, "web", "operator.write", "resumed"],
] as const;

/** A client carrying its turn's admitted authority; the grant decides automations. */
export function admittedInternal(scope: string, internal: Record<string, unknown> = {}) {
  return {
    ...internal,
    operatorRunAuthority: createTestOperatorAuthority({
      profileId: "gateway-owner",
      scopes: [scope],
    }),
  };
}

export const deniedChatCronAuthorityCases = [
  {
    name: "internal re-entry, including Talk consults",
    client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
    directExternal: false,
    message: "Talk realtime agent consult prompt",
  },
  {
    name: "incognito session",
    client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
    sessionEntry: { incognito: true },
  },
  {
    name: "synthetic client",
    client: {
      internal: { isLocalClient: true, syntheticClient: true },
      scopes: ["operator.admin"],
    },
  },
  {
    name: "input provenance",
    client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
    requestParams: { systemInputProvenance: { kind: "external_user" } },
  },
  {
    name: "explicit origin",
    client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
    requestParams: { originatingChannel: "slack", originatingTo: "D123" },
  },
  {
    name: "delegated handoff",
    client: {
      internal: { isLocalClient: true, delegatedToolPolicyHandoffId: "handoff-1" },
      scopes: ["operator.admin"],
    },
  },
  {
    name: "spawned lineage",
    client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
    sessionEntry: { spawnedBy: "agent:main:parent" },
  },
  {
    name: "persisted cron continuation",
    client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
    sessionEntry: {
      cronRunContinuation: { lifecycleRevision: "revision-1", phase: "running" },
    },
  },
];

/** An ACP CLI client whose turn admission carries an owner grant. */
export function createAdmittedAcpClient() {
  return {
    ...createScopedCliClient(["operator.admin"], { id: "cli", displayName: "ACP", version: "acp" }),
    internal: {
      operatorRunAuthority: createTestOperatorAuthority({
        profileId: "acp-owner",
        scopes: ["operator.admin"],
      }),
    },
  };
}

export function createExpectedAcpUserTurn(params: {
  content: string;
  idempotencyKey: string;
  senderIsOwner?: boolean;
  operatorProfileId?: string;
  provenance?: InputProvenance;
}) {
  return {
    role: "user",
    content: params.content,
    timestamp: expect.any(Number),
    idempotencyKey: params.idempotencyKey,
    __openclaw: {
      chatRequestIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      modelSelection: { provider: "openai", model: "gpt-6-astra" },
      requesterOrigin: {
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
        chatType: "direct",
        ...(params.operatorProfileId ? { operatorProfileId: params.operatorProfileId } : {}),
      },
      ...(params.senderIsOwner === undefined ? {} : { senderIsOwner: params.senderIsOwner }),
      transport: { clients: [{ id: "cli", mode: "cli", displayName: "ACP" }] },
    },
    ...(params.provenance ? { provenance: params.provenance } : {}),
  };
}

export function managedAudioBlocks(content: Array<Record<string, unknown>>) {
  return content.filter((block) => block.type === "audio");
}

export function expectManagedAudioBlock(
  block: Record<string, unknown> | undefined,
  fileName: string,
  isVoiceNote?: boolean,
) {
  expect(block).toMatchObject({
    type: "audio",
    artifactId: expect.stringMatching(/^artifact_managed_media_/u),
    fileName,
    mimeType: "audio/mpeg",
    ...(isVoiceNote === undefined ? {} : { isVoiceNote }),
  });
}

export class ChatDirectiveDedupe extends Map<string, DedupeEntry> {
  private readonly pending = new Map<string, ReturnType<typeof createDeferred<void>>>();

  constructor(private readonly signal: AbortSignal) {
    super();
  }

  override set(key: string, entry: DedupeEntry): this {
    super.set(key, entry);
    if (key.startsWith("chat:")) {
      const runId = key.slice("chat:".length);
      if (readChatSendDedupeResponse(this, runId)) {
        this.pending.get(runId)?.resolve();
      }
    }
    return this;
  }

  async waitForResponse(runId: string): Promise<void> {
    if (!readChatSendDedupeResponse(this, runId)) {
      const publication = this.pending.get(runId) ?? createDeferred();
      this.pending.set(runId, publication);
      try {
        await withinTest(publication.promise, this.signal);
      } finally {
        this.pending.delete(runId);
      }
    }
    this.signal.throwIfAborted();
    // Admission retains request identity before a response-bearing receipt exists.
    expect(readChatSendDedupeResponse(this, runId)).toBeDefined();
  }
}

type NonStreamingChatSendWaitFor = "broadcast" | "dedupe" | "none";
type ChatDirectiveSendContext = GatewayRequestContext & {
  dedupe: ChatDirectiveDedupe;
  broadcast: ReturnType<typeof vi.fn<GatewayRequestContext["broadcast"]>>;
};

/** The suite binds handlers after installing its module mocks. */
export function createChatDirectiveSender(handlers: {
  internal: (options: GatewayRequestHandlerOptions) => Promise<void>;
  external: (options: GatewayRequestHandlerOptions) => Promise<void>;
}) {
  return async (params: {
    context: ChatDirectiveSendContext;
    respond: RespondFn;
    idempotencyKey: string;
    message?: string;
    sessionKey?: string;
    deliver?: boolean;
    client?: unknown;
    expectBroadcast?: boolean;
    requestParams?: Record<string, unknown>;
    directExternal?: boolean;
    waitForCompletion?: boolean;
    waitFor?: NonStreamingChatSendWaitFor;
  }): Promise<Record<string, unknown> | undefined> => {
    const handler = params.directExternal === false ? handlers.internal : handlers.external;
    await handler({
      params: {
        sessionKey: params.sessionKey ?? "main",
        message: params.message ?? "hello",
        idempotencyKey: params.idempotencyKey,
        ...(typeof params.deliver === "boolean" ? { deliver: params.deliver } : {}),
        ...params.requestParams,
      },
      respond: params.respond,
      req: {} as never,
      client: (params.client ?? null) as never,
      isWebchatConnect: () => false,
      context: params.context,
    });

    const waitFor =
      params.waitFor ??
      (params.waitForCompletion === false
        ? "none"
        : params.expectBroadcast === false
          ? "dedupe"
          : "broadcast");
    if (waitFor === "none") {
      return undefined;
    }
    await params.context.dedupe.waitForResponse(params.idempotencyKey);
    if (waitFor === "dedupe") {
      return undefined;
    }
    const terminalCalls = params.context.broadcast.mock.calls.filter(
      ([event, payload]) => event === "chat" && asOptionalRecord(payload)?.state !== "delta",
    );
    expect(terminalCalls).toHaveLength(1);
    return asOptionalRecord(terminalCalls[0]?.[1]);
  };
}

export type ChatDirectiveSessionState = {
  config: Record<string, unknown>;
  mainSessionKey: string;
  sessionEntry: Record<string, unknown>;
  sessionMissing: boolean;
  sessionIdsByKey: Map<string, string>;
  sessionId: string;
  storePath: string;
  transcriptPath: string;
};

export function createGlobalChatDirectiveConfig(): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: {
        systemAgent: { agentId: "main" },
        sessionStore: { agentId: "main" },
      },
      entries: { main: {}, work: {} },
    },
    session: { scope: "global" },
  };
}

export function readChatDirectiveConfig(
  state: Pick<ChatDirectiveSessionState, "config" | "mainSessionKey" | "storePath">,
): OpenClawConfig {
  const session = state.config.session as OpenClawConfig["session"];
  const agents = state.config.agents as OpenClawConfig["agents"];
  // Chat runs need a configured model; fixtures that name none get the test default.
  const withModel = agents?.defaults?.model
    ? state.config
    : {
        ...state.config,
        agents: { ...agents, defaults: { ...agents?.defaults, model: "openai/gpt-6-astra" } },
      };
  return inheritLegacyDefaultAgentId(withModel, {
    ...withModel,
    session: {
      ...session,
      mainKey: state.mainSessionKey,
      store: session?.store ?? state.storePath,
    },
  });
}

export function createChatDirectiveSuiteResources() {
  const fixtureLifetime = createFixtureLifetime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-directive-suite-"));
  const databasePath = path.join(root, "openclaw-agent.sqlite");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const previousEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
  const databaseOwners = new Map([[databasePath, "main"]]);
  let metadataOwner: GatewayPluginMetadataOwner | undefined;
  const closeDatabase = async (storePath: string, agentId: string) => {
    await drainAgentDatabaseResources({ path: storePath, agentId }, async () =>
      disposeOpenClawAgentDatabaseByPath(storePath, { env }),
    );
    databaseOwners.delete(storePath);
  };
  return {
    root,
    databasePath,
    env,
    runFixture: fixtureLifetime.run,
    verifyFixtureCleanup: fixtureLifetime.verifyCleanup,
    settleFixtures: () => fixtureLifetime.cleanup(),
    openDatabase(agentId: string, storePath: string) {
      databaseOwners.set(storePath, agentId);
      openOpenClawAgentDatabase({ agentId, env, path: storePath });
    },
    async closeCaseDatabases() {
      for (const [storePath, agentId] of databaseOwners) {
        if (storePath !== databasePath) {
          await closeDatabase(storePath, agentId);
        }
      }
    },
    // The caller retains cleanup ownership before opening can fail.
    open() {
      setTestEnvValue("OPENCLAW_STATE_DIR", root);
      openOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
      // Session cases share the installed inventory through per-case runtime resets.
      metadataOwner = retainGatewayPluginMetadata(createTestGatewayScheduler());
      const snapshot = metadataOwner.runBootstrap(() =>
        loadPluginMetadataSnapshot({ config: {}, allowCurrent: false }),
      );
      metadataOwner.publish(snapshot);
      setGatewayPluginMetadataSnapshot(snapshot, { config: {} });
    },
    loadSessionEntry(
      state: ChatDirectiveSessionState,
      rawKey: string,
      opts?: { agentId?: string },
    ) {
      const fallbackKey = `agent:${opts?.agentId ?? "main"}:${state.mainSessionKey}`;
      const canonicalKey =
        typeof state.sessionEntry.canonicalKey === "string"
          ? state.sessionEntry.canonicalKey
          : rawKey && rawKey !== "main"
            ? rawKey
            : fallbackKey;
      const { canonicalKey: _canonicalKey, ...sessionEntry } = state.sessionEntry;
      const persistedEntry = state.sessionMissing
        ? undefined
        : {
            ...sessionEntry,
            sessionId: state.sessionIdsByKey.get(rawKey) ?? state.sessionId,
            updatedAt: typeof sessionEntry.updatedAt === "number" ? sessionEntry.updatedAt : 1,
          };
      const entry = persistedEntry && { ...persistedEntry, sessionFile: state.transcriptPath };
      const cfg = readChatDirectiveConfig(state);
      let captured: CapturedSessionEntryReadSource | undefined;
      loadExactSessionEntryCandidates({
        readSource: {
          agentId: expectDefined(databaseOwners.get(state.storePath), "fixture database owner"),
          path: state.storePath,
        },
        env,
        sessionKeys: [canonicalKey],
        readOnly: true,
        onReadSource: (source) => {
          captured = source;
        },
      });
      const capturedReadSource = expectDefined(captured, "chat directive fixture database source");
      return {
        cfg,
        agentId: resolveSessionStoreAgentId(cfg, rawKey, opts?.agentId),
        storePath: state.storePath,
        store: entry ? { [canonicalKey]: entry } : {},
        entry,
        canonicalKey,
        storeKeys: [canonicalKey],
        persistedEntry,
        readSource: { agentId: capturedReadSource.agentId, path: capturedReadSource.path },
        capturedReadSource,
        capturedReadSources: [capturedReadSource],
      };
    },
    async close() {
      try {
        expect((await metadataOwner?.close())?.failures ?? []).toEqual([]);
        for (const [storePath, agentId] of databaseOwners) {
          await closeDatabase(storePath, agentId);
        }
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
        fs.rmSync(root, { recursive: true, force: true });
      } finally {
        previousEnv.restore();
      }
    },
  };
}

export async function seedChatDirectiveFileTranscript(
  scope: SessionAccessScope,
  sessionId: string,
  sessionFile: string,
) {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
  // The accessor resolves transcript targets from the persisted store, not the mocked Gateway.
  await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
}

export function expectClaimOnlyTranscriptMedia(
  message: unknown,
  expectedMedia: unknown[],
  forbiddenValues: string[],
) {
  const media = (
    message as { __openclaw?: { media?: Array<Record<string, unknown>> } } | undefined
  )?.["__openclaw"]?.media;
  expect(media).toEqual(expectedMedia);
  for (const fact of media ?? []) {
    expect(fact.url).toMatch(/^media:\/\/inbound\/[^?#]+$/u);
    for (const key of ["path", "workspaceDir", "data"]) {
      expect(fact).not.toHaveProperty(key);
    }
  }
  const serialized = JSON.stringify(message);
  for (const value of ["base64", ...forbiddenValues]) {
    expect(serialized).not.toContain(value);
  }
}

export function createChatDirectiveReplyBackend(params: {
  cancel?: ReplyBackendHandle["cancel"];
  isStopped?: ReplyBackendHandle["isStopped"];
  isStreaming?: ReplyBackendHandle["isStreaming"];
  legacy?: boolean;
  queueMessage: NonNullable<ReplyBackendHandle["queueMessage"]>;
  runId?: string;
  supportsQueueMessageImages?: boolean;
  taskSuggestionDeliveryMode?: "gateway";
}): ReplyBackendHandle {
  return {
    kind: "embedded",
    cancel: params.cancel ?? (() => {}),
    runId: params.runId,
    supportsQueueMessageImages: params.supportsQueueMessageImages,
    supportsTranscriptCommitWait: true,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    ...(params.legacy
      ? {
          queueMessage: params.queueMessage,
          isStopped: params.isStopped,
          isStreaming: params.isStreaming,
        }
      : {
          // Production steering adapters use V2. The mock queue is this fixture
          // backend's final handoff, so retain the source guard at that boundary.
          messageInjectionV2: {
            version: 2 as const,
            isAvailable: () => true,
            queueMessage: (text, options, assertCurrent) => {
              assertCurrent();
              return params.queueMessage(text, options);
            },
          },
        }),
  };
}

export function createUnconfirmedTranscriptDelivery() {
  const queueLifetime = createFixtureLifetime();
  const delivery = createDeferred<{
    transcriptCommit: "unconfirmed";
    errorMessage: string;
  }>();
  const persisted = createDeferred();
  void persisted.promise.catch(() => {});
  const queueMessage = vi.fn<NonNullable<ReplyBackendHandle["queueMessage"]>>((_text, options) =>
    queueLifetime.track(
      (async () => {
        options?.onQueueAccepted?.(true);
        try {
          await options?.userTurnTranscriptRecorder?.persistApproved();
          persisted.resolve();
        } catch (error) {
          persisted.reject(error);
          throw error;
        }
        return await delivery.promise;
      })(),
    ),
  );
  return {
    ...delivery,
    persisted: persisted.promise,
    queueMessage,
    settle: () => queueLifetime.cleanup(),
  };
}

export function createChatDirectiveUserMessageReader(
  readEntries: () => Array<Record<string, unknown>>,
) {
  return () =>
    readEntries().flatMap(({ message }) => {
      const record = asOptionalRecord(message);
      return record?.role === "user" ? [record] : [];
    });
}
