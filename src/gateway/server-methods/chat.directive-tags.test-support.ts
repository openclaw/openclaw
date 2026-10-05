import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { expect, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { ReplyBackendHandle } from "../../auto-reply/reply/reply-run-registry.contracts.js";
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
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { DedupeEntry } from "../server-shared.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { readChatSendDedupeResponse } from "./chat-send-reservation.js";

export function expectManagedAudioBlock(
  block: Record<string, unknown> | undefined,
  fileName: string,
  isVoiceNote?: boolean,
) {
  expect(block).toEqual(
    expect.objectContaining({
      type: "audio",
      artifactId: expect.stringMatching(/^artifact_managed_media_/u),
      fileName,
      mimeType: "audio/mpeg",
      ...(isVoiceNote === undefined ? {} : { isVoiceNote }),
    }),
  );
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
  return inheritLegacyDefaultAgentId(state.config, {
    ...state.config,
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
      const canonicalKey =
        typeof state.sessionEntry.canonicalKey === "string"
          ? state.sessionEntry.canonicalKey
          : rawKey === "main"
            ? `agent:${opts?.agentId ?? "main"}:${state.mainSessionKey}`
            : rawKey || `agent:${opts?.agentId ?? "main"}:${state.mainSessionKey}`;
      const { canonicalKey: _canonicalKey, ...sessionEntry } = state.sessionEntry;
      const persistedEntry = state.sessionMissing
        ? undefined
        : {
            ...sessionEntry,
            sessionId: state.sessionIdsByKey.get(rawKey) ?? state.sessionId,
            updatedAt: typeof sessionEntry.updatedAt === "number" ? sessionEntry.updatedAt : 1,
          };
      const entry = persistedEntry
        ? { ...persistedEntry, sessionFile: state.transcriptPath }
        : undefined;
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
        const metadataCleanup = await metadataOwner?.close();
        expect(metadataCleanup?.failures ?? []).toEqual([]);
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
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  // The accessor resolves transcript targets from the persisted store, not the mocked Gateway.
  await replaceSessionEntry(scope, {
    sessionId,
    updatedAt: Date.now(),
  });
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
    expect(fact).not.toHaveProperty("path");
    expect(fact).not.toHaveProperty("workspaceDir");
    expect(fact).not.toHaveProperty("data");
  }
  const serialized = JSON.stringify(message);
  expect(serialized).not.toContain("base64");
  for (const value of forbiddenValues) {
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
    readEntries()
      .map((entry) => entry.message)
      .filter(
        (candidate): candidate is Record<string, unknown> =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as { role?: unknown }).role === "user",
      );
}
