import { isDeepStrictEqual } from "node:util";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceAuthority } from "../../agents/sandbox/workspace-authority.js";
import { runWithLocalStateOwner } from "../../cli/local-state-owner.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  listImageGenerationProviders,
  listMusicGenerationProviders,
  listVideoGenerationProviders,
} from "../../media-generation/registry.js";
import { RequestScopedSubagentRuntimeError } from "../../plugin-sdk/error-runtime.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import {
  resolveNativePluginModelAuth,
  resolveNativePluginModelConfig,
} from "../loader-runtime-load.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { createRuntimeBase } from "./runtime-base.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { subscribeRuntimeSessionChanges } from "./session-changes.js";
import type { PluginRuntimeFactory, PluginRuntime } from "./types.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../plugin-sdk/tts-runtime.js"));
const loadTtsRequestRuntime = createLazyRuntimeModule(() => import("../../tts/runtime-api.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("../../media-understanding/runtime.js"),
);
const loadGatewayPluginRuntime = createLazyRuntimeModule(
  () => import("../../gateway/server-plugins.js"),
);

function createRuntimeGateway(): PluginRuntime["gateway"] {
  return {
    isAvailable: async () => (await loadGatewayPluginRuntime()).hasInProcessGatewayContext(),
    request: async (method, params, options) => {
      const runtime = await loadGatewayPluginRuntime();
      return runtime.dispatchTrustedPluginGatewayMethod(method, params, options);
    },
    openPluginPanel: async (params) =>
      (await loadGatewayPluginRuntime()).openPluginPanelForRequester(params),
    readSessionFacts: async (params) =>
      (await loadGatewayPluginRuntime()).readTrustedPluginSessionFacts(params),
    withSessionFacts: async (select, run) =>
      (await loadGatewayPluginRuntime()).withTrustedPluginSessionFacts(select, run),
    subscribeSessionChanges: subscribeRuntimeSessionChanges,
    withUserProfileIdentity: async (params, run) => {
      const captured = {
        profileId: params.profileId,
        emails: params.emails.slice(),
        githubAccountIds:
          params.githubAccountIds === undefined ? undefined : params.githubAccountIds.slice(),
      };
      const runtime = await loadGatewayPluginRuntime();
      return runtime.withTrustedPluginUserProfileIdentity(captured, run);
    },
    resolveGitHubAccount: async ({ login, signal }) =>
      (await loadGatewayPluginRuntime()).resolveTrustedPluginGitHubAccount({ login, signal }),
  };
}

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  const bindTtsRequestRuntime = createLazyRuntimeMethodBinder(loadTtsRequestRuntime);
  return {
    prepareTtsRequest: bindTtsRequestRuntime((runtime) => runtime.prepareTtsRequest),
    textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
    textToSpeechStream: bindTtsRuntime((runtime) => runtime.textToSpeechStream),
    textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  return {
    resolveAudioInputBudget: bindMediaUnderstandingRuntime(
      (runtime) => runtime.resolveAudioInputBudget,
    ),
    runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
    describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
    describeImageFileWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.describeImageFileWithModel,
    ),
    extractStructuredWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.extractStructuredWithModel,
    ),
    describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
    transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile),
  };
}

function createRuntimeLlmFacade(): PluginRuntime["llm"] {
  const loadAcquireLocalService = createLazyRuntimeMethod(
    () => import("../../agents/provider-local-service.js"),
    (runtime) => runtime.createConfiguredProviderLocalServiceAcquirer(getRuntimeConfig),
  );
  const loadLlm = createLazyRuntimeSurface(
    () => import("./runtime-llm.runtime.js"),
    (m) =>
      m.createRuntimeLlm({
        getConfig: getRuntimeConfig,
        authority: {
          allowComplete: true,
        },
      }),
  );
  return {
    acquireLocalService: loadAcquireLocalService,
    complete: createLazyRuntimeMethod(loadLlm, (llm) => llm.complete),
  };
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new RequestScopedSubagentRuntimeError();
  };
  return {
    complete: unavailable,
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    deleteSession: unavailable,
  };
}

function createUnavailableNodesRuntime(): PluginRuntime["nodes"] {
  const unavailable = () => {
    throw new Error("Plugin node runtime is only available inside the Gateway.");
  };
  return {
    list: unavailable,
    invoke: unavailable,
    openDuplex: unavailable,
  };
}

function createRuntimeWorktrees(): PluginRuntime["worktrees"] {
  const loadService = () => import("../../agents/worktrees/service.js");
  return {
    async resolveCheckoutRoot(params) {
      const { findGitCheckoutRoot } = await import("../../agents/worktrees/git.js");
      return findGitCheckoutRoot(params.path) ?? undefined;
    },
    async hasSelfContainedCheckoutMetadata(params) {
      const { hasSelfContainedGitMetadata } = await import("../../agents/worktrees/git.js");
      return await hasSelfContainedGitMetadata(params.path);
    },
    async create(params) {
      return runWithLocalStateOwner({
        method: "worktrees.create",
        params: {},
        target: params.repoRoot,
        onForeignOwner: "refuse",
        runLocal: async ({ env, config, signal, assertCurrent }) => {
          const { ManagedWorktreeService } = await loadService();
          const commitGuard = () => {
            assertCurrent();
            params.commitGuard?.();
          };
          commitGuard();
          const service = new ManagedWorktreeService({ env, getConfig: () => config });
          const record = await service.create({ ...params, signal, commitGuard });
          commitGuard();
          await service.acquire(record.id, { signal, commitGuard });
          return { id: record.id, path: record.path, branch: record.branch };
        },
      });
    },
    async release(params) {
      return runWithLocalStateOwner({
        method: "worktrees.release",
        params: {},
        target: params.path,
        onForeignOwner: "refuse",
        runLocal: async ({ env, config, signal, assertCurrent }) => {
          const { ManagedWorktreeService } = await loadService();
          assertCurrent();
          await new ManagedWorktreeService({ env, getConfig: () => config }).releaseByPath(
            params.path,
            { signal, commitGuard: assertCurrent },
          );
        },
      });
    },
    async removeIfLossless(params) {
      return runWithLocalStateOwner({
        method: "worktrees.removeIfLossless",
        params: {},
        target: params.path,
        onForeignOwner: "refuse",
        runLocal: async ({ env, config, signal, assertCurrent }) => {
          const { ManagedWorktreeService } = await loadService();
          assertCurrent();
          return new ManagedWorktreeService({
            env,
            getConfig: () => config,
          }).removeIfLosslessByPath(
            params.path,
            { ownerKind: params.ownerKind, ownerId: params.ownerId },
            { signal, commitGuard: assertCurrent },
          );
        },
      });
    },
  };
}

function createRuntimeSandbox(agent: PluginRuntime["agent"]): PluginRuntime["sandbox"] {
  const readCurrentEntry = (
    params: Parameters<PluginRuntime["sandbox"]["resolveWorkspaceAuthority"]>[0],
    source: ReturnType<typeof captureIncognitoSessionSource>,
  ) => {
    source?.admissionSignal?.throwIfAborted();
    if (!source) {
      return agent.session.getSessionEntry({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(params.storePath ? { storePath: params.storePath } : {}),
      });
    }
    if ("kind" in source) {
      source.assertCurrent();
      return undefined;
    }
    const key = resolveSqliteSessionKey(params.sessionKey, source.actor.agentId);
    const entry = source.actor.sessions.readCapability(key);
    return entry ? { ...entry, ...source.actor.sessions.readPolicy(key) } : undefined;
  };
  return {
    resolveWorkspaceAuthority(params) {
      const source = captureIncognitoSessionSource(params);
      const sessionEntry = readCurrentEntry(params, source);
      const preparedRuntimeStatus = resolveSandboxRuntimeStatus({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        preparedSessionEntry: sessionEntry ?? null,
      });
      return resolveSandboxWorkspaceAuthority({ ...params, sessionEntry, preparedRuntimeStatus });
    },
    async prepareWorkspaceAuthority(input) {
      const params = { ...input };
      const source = captureIncognitoSessionSource(params);
      const prepare = async () => {
        const sessionEntry = await agent.session.getSessionEntryAsync({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          ...(params.storePath ? { storePath: params.storePath } : {}),
        });
        const fields = [
          "sessionId",
          "lifecycleRevision",
          "sandbox",
          "sandboxMode",
          "createdActor",
          "execHost",
          "execNode",
          "model",
          "modelProvider",
          "modelOverride",
          "providerOverride",
        ] as const;
        const expected = fields.map((field) => structuredClone(sessionEntry?.[field]));
        const assertCurrent = () => {
          const current = readCurrentEntry(params, source);
          if (
            fields.some((field, index) => !isDeepStrictEqual(expected[index], current?.[field]))
          ) {
            throw new Error("Session workspace authority changed during sandbox preparation.");
          }
        };
        assertCurrent();
        const preparedRuntimeStatus = resolveSandboxRuntimeStatus({
          cfg: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          preparedSessionEntry: sessionEntry ?? null,
        });
        const authority = resolveSandboxWorkspaceAuthority({
          ...params,
          sessionEntry,
          preparedRuntimeStatus,
        });
        if (!authority.sandboxed || authority.confinementError) {
          return authority;
        }
        const { resolveSandboxContext } = await import("../../agents/sandbox/context.js");
        assertCurrent();
        await resolveSandboxContext({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          requireCurrentConfig: true,
          preparedRuntimeStatus,
          assertCurrent,
        });
        assertCurrent();
        return authority;
      };
      return source && !("kind" in source)
        ? source.actor.sessions.withSharedState(prepare)
        : prepare();
    },
  };
}

// Loaded by path from the plugin loader, so static export analysis cannot see this contract.
export const createPluginRuntime: PluginRuntimeFactory = (
  _options = {},
  base = createRuntimeBase(),
) => {
  const agent = createRuntimeAgent();
  let modelAuth = _options.modelAuth;
  let modelConfig = _options.modelConfig;
  const runtime: PluginRuntime = {
    version: VERSION,
    capabilities: base.capabilities,
    decisions: {
      evaluate: async (...args) =>
        (await import("../../decisions/runtime.js")).evaluateDecision(...args),
    },
    gateway: _options.gateway ?? createRuntimeGateway(),
    config: base.config,
    agent,
    hooks: _options.hooks ?? {
      dispatchHookAgentTurn: async () => {
        throw new Error("Plugin hook runtime is only available inside the Gateway.");
      },
    },
    subagent: _options.subagent ?? createUnavailableSubagentRuntime(),
    nodes: _options.nodes ?? createUnavailableNodesRuntime(),
    sandbox: createRuntimeSandbox(agent),
    worktrees: createRuntimeWorktrees(),
    system: base.system,
    media: createRuntimeMedia(),
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    channel: createRuntimeChannel(
      _options.dispatchReplyFromConfig
        ? { dispatchReplyFromConfig: _options.dispatchReplyFromConfig }
        : undefined,
    ),
    events: { onAgentEvent, onSessionTranscriptUpdate },
    logging: createRuntimeLogging(),
    state: base.state,

    tts: createRuntimeTts(),
    mediaUnderstanding: createRuntimeMediaUnderstandingFacade(),
    get modelAuth() {
      return (modelAuth ??= resolveNativePluginModelAuth());
    },
    get modelConfig() {
      return (modelConfig ??= resolveNativePluginModelConfig());
    },
    // Listings stay synchronous; execution loads only when requested.
    imageGeneration: {
      generate: async (params) =>
        (await import("../../image-generation/runtime.js")).generateImage(params),
      listProviders: (params) => listImageGenerationProviders(params?.config),
    },
    videoGeneration: {
      generate: async (params) =>
        (await import("../../video-generation/runtime.js")).generateVideo(params),
      listProviders: (params) => listVideoGenerationProviders(params?.config),
    },
    musicGeneration: {
      generate: async (params) =>
        (await import("../../music-generation/runtime.js")).generateMusic(params),
      listProviders: (params) => listMusicGenerationProviders(params?.config),
    },
    llm: createRuntimeLlmFacade(),
  };
  // SDK consumers retain these getter-only descriptors after lazy runtime materialization.
  for (const key of [
    "tts",
    "mediaUnderstanding",
    "imageGeneration",
    "videoGeneration",
    "musicGeneration",
    "llm",
  ] as const) {
    const value = runtime[key];
    Object.defineProperty(runtime, key, { get: () => value });
  }
  return runtime;
};

export type { PluginRuntime } from "./types.js";
