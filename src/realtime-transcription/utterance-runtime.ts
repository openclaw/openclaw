import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { isProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveProviderExecutionAuth } from "../media-understanding/provider-execution.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../media-understanding/provider-registry.js";
import {
  resolveEntryRunOptions,
  resolveModelEntries,
  resolveScopeDecision,
} from "../media-understanding/resolve.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import { assertRuntimeMediaRequestSecretOwnerAvailable } from "../secrets/runtime-media-secret-owner.js";
import { getRealtimeTranscriptionProvider } from "./provider-registry.js";
import type { RealtimeTranscriptionAudioFormat } from "./provider-types.js";

export type TranscribeAudioStreamParams = {
  cfg: OpenClawConfig;
  agentId: string;
  audio: AsyncIterable<Uint8Array>;
  format: RealtimeTranscriptionAudioFormat;
  signal: AbortSignal;
  language?: string;
  maxAudioBytes?: number;
  timeoutMs?: number;
  scopeContext?: { sessionKey?: string; channel?: string; chatType?: string };
};

export type TranscribeAudioStreamResult =
  | { supported: false; reason: string }
  | {
      supported: true;
      text: string;
      no_speech: boolean;
      mode: "realtime";
      provider: string;
      model?: string;
    };

/**
 * Uses the configured first audio model, never a different provider merely to
 * obtain streaming. Unsupported is returned BEFORE touching the input iterator.
 * Once admitted, any provider/transport failure throws; callers must not replay
 * the partially uploaded utterance through a fallback provider automatically.
 */
export async function transcribeAudioStream(
  params: TranscribeAudioStreamParams,
): Promise<TranscribeAudioStreamResult> {
  const owner = getPluginRuntimeGatewayRequestScope()?.transcriptionOwner;
  const callerSignal = owner?.signal
    ? AbortSignal.any([params.signal, owner.signal])
    : params.signal;
  const assertCurrent = () => {
    callerSignal.throwIfAborted();
    owner?.assertCurrent();
  };
  assertCurrent();
  const config = params.cfg.tools?.media?.audio;
  if (
    config?.enabled === false ||
    resolveScopeDecision({
      scope: config?.scope,
      ctx: {
        SessionKey: params.scopeContext?.sessionKey,
        Surface: params.scopeContext?.channel,
        ChatType: params.scopeContext?.chatType,
      },
    }) === "deny"
  ) {
    throw new Error("Audio transcription is disabled by policy.");
  }
  const registry = buildMediaUnderstandingRegistry(undefined, params.cfg);
  const selection = resolveModelEntries({
    cfg: params.cfg,
    capability: "audio",
    config,
    providerRegistry: registry,
  })[0];
  const selected = selection?.entry;
  if (!selected?.provider || selected.type === "cli" || selected.command) {
    return { supported: false, reason: "configured_audio_selection_requires_batch" };
  }
  const assertAvailable = () => {
    assertCurrent();
    assertRuntimeMediaRequestSecretOwnerAvailable({ capability: "audio", entry: selected });
    if (selection?.secretOwnerId) {
      assertSecretOwnerAvailable("capability", selection.secretOwnerId);
    }
  };
  assertAvailable();
  // This first finite contract cannot faithfully translate batch auth/request options.
  // Leave them to the batch owner instead of silently using ambient credentials.
  const modelProviderConfig = findNormalizedProviderValue(
    params.cfg.models?.providers,
    selected.provider,
  );
  if (
    modelProviderConfig?.headers ||
    modelProviderConfig?.request ||
    !selected.model ||
    selected.profile ||
    selected.preferredProfile ||
    selected.request ||
    selected.headers ||
    selected.providerOptions ||
    selected.prompt ||
    config?.request ||
    config?.headers ||
    config?.providerOptions ||
    config?.prompt
  ) {
    return { supported: false, reason: "configured_audio_selection_requires_batch" };
  }
  const provider = getRealtimeTranscriptionProvider(selected.provider, params.cfg);
  const capability = provider?.utterance;
  if (!provider || !capability) {
    return { supported: false, reason: "provider_has_no_utterance_finalization" };
  }
  if (
    !capability.formats.some(
      (format) =>
        format.encoding === params.format.encoding &&
        format.sampleRate === params.format.sampleRate &&
        format.channels === params.format.channels,
    )
  ) {
    return { supported: false, reason: "unsupported_realtime_audio_format" };
  }
  if (selected.model && capability.models && !capability.models.includes(selected.model)) {
    return { supported: false, reason: "selected_model_requires_batch" };
  }
  const model = selected.model;
  let apiKey: string | undefined;
  try {
    const auth = await resolveProviderExecutionAuth({
      capability: "audio",
      cfg: params.cfg,
      entry: selected,
      providerId: selected.provider,
      provider: getMediaUnderstandingProvider(selected.provider, registry),
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
    });
    if (auth.kind === "api-key") {
      apiKey = auth.apiKeys[0];
    }
  } catch (error) {
    if (
      isProviderAuthError(error, "missing-provider-auth") ||
      isProviderAuthError(error, "missing-api-key")
    ) {
      return { supported: false, reason: "realtime_provider_not_configured" };
    }
    throw error;
  }
  assertAvailable();
  const rawConfig = {
    ...modelProviderConfig,
    ...(config?.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...selected,
    ...(model ? { model, modelId: model } : {}),
    apiKey,
    language: params.language ?? selected.language ?? config?.language,
  };
  const providerConfig = provider.resolveConfig?.({ cfg: params.cfg, rawConfig }) ?? rawConfig;
  const context = { cfg: params.cfg, providerConfig };
  const configured = provider.isConfiguredAsync
    ? await provider.isConfiguredAsync(context)
    : provider.isConfigured(context);
  assertCurrent();
  if (!configured) {
    return { supported: false, reason: "realtime_provider_not_configured" };
  }
  const limits = resolveEntryRunOptions({
    cfg: params.cfg,
    capability: "audio",
    entry: selected,
    config,
  });
  const maxBytes = Math.min(params.maxAudioBytes ?? 2 * 1024 * 1024, limits.maxBytes);
  const timeoutMs = Math.min(params.timeoutMs ?? 300_000, limits.timeoutMs);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 300_000
  ) {
    throw new Error("Invalid realtime transcription limits.");
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([callerSignal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new Error("Realtime transcription timed out.")),
    timeoutMs,
  );
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => {});
  const onAbort = () =>
    rejectFailure(
      signal.reason instanceof Error ? signal.reason : new Error("Transcription aborted."),
    );
  signal.addEventListener("abort", onAbort, { once: true });
  let session: ReturnType<typeof provider.createSession> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let completedInput = false;
  const wait = <T>(promise: Promise<T>) => Promise.race([promise, failure]);
  try {
    signal.throwIfAborted();
    session = provider.createSession({
      cfg: params.cfg,
      agentId: params.agentId,
      providerConfig,
      utterance: { format: params.format, signal },
      onError: rejectFailure,
    });
    if (!session.finishInput || !session.writeAudio) {
      throw new Error("Realtime provider advertised finalization without implementing it.");
    }
    iterator = params.audio[Symbol.asyncIterator]();
    let bytes = 0;
    let connected = false;
    while (true) {
      const next = await wait(iterator.next());
      assertCurrent();
      signal.throwIfAborted();
      if (next.done) {
        completedInput = true;
        break;
      }
      const chunk = next.value;
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength === 0 ||
        chunk.byteLength % 2 !== 0 ||
        chunk.byteLength > 32768 ||
        bytes + chunk.byteLength > maxBytes
      ) {
        throw new Error("Invalid or oversized realtime PCM input.");
      }
      if (!connected) {
        assertAvailable();
        await wait(session.connect());
        connected = true;
      }
      assertAvailable();
      signal.throwIfAborted();
      await wait(session.writeAudio(Buffer.from(chunk)));
      bytes += chunk.byteLength;
    }
    assertAvailable();
    const result = bytes ? await wait(session.finishInput()) : { text: "" };
    assertAvailable();
    signal.throwIfAborted();
    return {
      supported: true,
      text: result.text,
      no_speech: !result.text.trim(),
      mode: "realtime",
      provider: provider.id,
      model,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
    session?.close();
    // The caller owns input cancellation. Do not hang cleanup behind a stalled
    // iterator.next(); fence it and request its return without awaiting it.
    if (iterator && !completedInput) {
      try {
        void iterator.return?.().catch(() => {});
      } catch {
        /* Preserve the request failure if a caller's cleanup also fails. */
      }
    }
  }
}
