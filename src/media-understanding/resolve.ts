// Resolution helpers derive media-understanding timeouts, prompts, byte/char
// caps, scope decisions, model entries, and concurrency.
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
  MediaUnderstandingScopeConfig,
} from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runtimeMediaModelSecretOwnerId } from "../secrets/runtime-media-secret-owner.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHARS_BY_CAPABILITY,
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_PROMPT,
  DEFAULT_TIMEOUT_SECONDS,
} from "./defaults.constants.js";
import { resolveEffectiveMediaEntryCapabilities } from "./entry-capabilities.js";
import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";
import type { MediaUnderstandingCapability } from "./types.js";

export type ResolvedMediaModelEntry = {
  entry: MediaUnderstandingModelConfig;
  secretOwnerId?: string;
};

class MediaCliModelUnavailableError extends Error {
  constructor(
    readonly reason: "cli-missing-command" | "cli-missing-attachment-arg",
    message: string,
  ) {
    super(`${reason}; ${message}`);
  }
}

/** Resolve executable CLI inputs without making invalid media config startup-fatal. */
export function resolveCliModelEntry(
  entry: MediaUnderstandingModelConfig,
): Result<{ command: string; args: string[] }, MediaCliModelUnavailableError> {
  const command = normalizeOptionalString(entry.command);
  if (!command) {
    return err(
      new MediaCliModelUnavailableError(
        "cli-missing-command",
        'Set command to the media executable and args to pass the attachment, for example ["{{AttachmentPath}}"].',
      ),
    );
  }
  const args = entry.args;
  // No stdin is supplied, so empty args cannot carry the attachment. Nonempty
  // literal/custom argv is a shipped command contract; interpolation is optional.
  if (!Array.isArray(args) || args.length === 0) {
    return err(
      new MediaCliModelUnavailableError(
        "cli-missing-attachment-arg",
        'Set args to pass the attachment, for example ["{{AttachmentPath}}"]. CLI stdin is not supplied.',
      ),
    );
  }
  return ok({ command, args });
}

/** Default per-provider media-understanding runtime timeout in milliseconds. */
const DEFAULT_MEDIA_RUNTIME_TIMEOUT_MS = 30_000;
const MIN_MEDIA_TIMEOUT_MS = 1000;

/** Converts configured timeout seconds into a timer-safe millisecond deadline. */
export function resolveTimeoutMs(seconds: number | undefined, fallbackSeconds: number): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : fallbackSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MIN_MEDIA_TIMEOUT_MS;
  }
  const timeoutMs = Math.floor(value * 1000);
  return resolveTimerTimeoutMs(
    Number.isFinite(timeoutMs) ? timeoutMs : MAX_TIMER_TIMEOUT_MS,
    MIN_MEDIA_TIMEOUT_MS,
    MIN_MEDIA_TIMEOUT_MS,
  );
}

/** Clamps an already-millisecond runtime timeout to the shared timer bounds. */
export function resolveMediaRuntimeTimeoutMs(timeoutMs: number | undefined): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_MEDIA_RUNTIME_TIMEOUT_MS);
}

/** Resolves the provider prompt and appends length guidance for non-audio outputs. */
function resolvePrompt(
  capability: MediaUnderstandingCapability,
  prompt?: string,
  maxChars?: number,
): string {
  const base = prompt?.trim() || DEFAULT_PROMPT[capability];
  if (!maxChars || capability === "audio") {
    return base;
  }
  return `${base} Respond in at most ${maxChars} characters.`;
}

/** Resolves the effective max response characters for a model entry and capability. */
function resolveMaxChars(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  config?: MediaUnderstandingConfig;
}): number | undefined {
  const { capability, entry, cfg } = params;
  const configured =
    entry.maxChars ?? params.config?.maxChars ?? cfg.tools?.media?.[capability]?.maxChars;
  if (typeof configured === "number") {
    return configured;
  }
  return DEFAULT_MAX_CHARS_BY_CAPABILITY[capability];
}

/** Resolves the effective input byte cap for a model entry and capability. */
export function resolveMaxBytes(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  config?: MediaUnderstandingConfig;
}): number {
  const configured =
    params.entry.maxBytes ??
    params.config?.maxBytes ??
    params.cfg.tools?.media?.[params.capability]?.maxBytes;
  if (typeof configured === "number") {
    return configured;
  }
  return DEFAULT_MAX_BYTES[params.capability];
}

export function resolveEntryRunOptions(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  config?: MediaUnderstandingConfig;
}): {
  maxBytes: number;
  maxChars?: number;
  timeoutMs: number;
  prompt: string;
  hasConfiguredPrompt: boolean;
} {
  const { capability, entry, cfg } = params;
  const maxBytes = resolveMaxBytes({ capability, entry, cfg, config: params.config });
  const maxChars = resolveMaxChars({ capability, entry, cfg, config: params.config });
  const timeoutMs = resolveTimeoutMs(
    entry.timeoutSeconds ??
      params.config?.timeoutSeconds ??
      cfg.tools?.media?.[capability]?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS[capability],
  );
  const configuredPrompt =
    entry.prompt ?? params.config?.prompt ?? cfg.tools?.media?.[capability]?.prompt;
  const prompt = resolvePrompt(capability, configuredPrompt, maxChars);
  return {
    maxBytes,
    maxChars,
    timeoutMs,
    prompt,
    hasConfiguredPrompt: Boolean(configuredPrompt?.trim()),
  };
}

/** Maps the message context to an allow/deny decision for configured media scope rules. */
export function resolveScopeDecision(params: {
  scope?: MediaUnderstandingScopeConfig;
  ctx: MsgContext;
}): "allow" | "deny" {
  return resolveMediaUnderstandingScope({
    scope: params.scope,
    sessionKey: params.ctx.SessionKey,
    channel: params.ctx.Surface ?? params.ctx.Provider,
    chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType),
  });
}

/** Resolves configured model entries that can handle the requested media capability. */
export function resolveModelEntries(params: {
  cfg: OpenClawConfig;
  capability: MediaUnderstandingCapability;
  config?: MediaUnderstandingConfig;
  providerRegistry: Map<string, { capabilities?: MediaUnderstandingCapability[] }>;
}): ResolvedMediaModelEntry[] {
  const { cfg, capability, config } = params;
  const sharedModels = cfg.tools?.media?.models ?? [];
  const entries: ResolvedMediaModelEntry[] = [];
  sharedModels.forEach((entry, index) => {
    const caps = resolveEffectiveMediaEntryCapabilities({
      entry,
      providerRegistry: params.providerRegistry,
    });
    if (!caps || caps.length === 0) {
      if (shouldLogVerbose()) {
        logVerbose(
          `Skipping shared media model without capabilities: ${entry.provider ?? entry.command ?? "unknown"}`,
        );
      }
      return;
    }
    if (caps.includes(capability)) {
      entries.push({ entry, secretOwnerId: runtimeMediaModelSecretOwnerId(index) });
    }
  });
  const preferred = config?.preferredModel?.trim();
  if (preferred) {
    entries.sort(
      (left, right) =>
        preferredMediaModelRank(right.entry, preferred) -
        preferredMediaModelRank(left.entry, preferred),
    );
  }
  return entries;
}

function preferredMediaModelRank(entry: MediaUnderstandingModelConfig, preferred: string): number {
  if (entry.type === "cli" || entry.command) {
    return preferred === `cli:${entry.command ?? ""}` ? 2 : 0;
  }
  const model = entry.model?.trim();
  if (!model) {
    return preferred === `provider:${entry.provider?.trim() ?? ""}` ? 2 : 0;
  }
  if (preferred === `${entry.provider?.trim() ?? ""}/${model}`) {
    return 2;
  }
  return preferred === model ? 1 : 0;
}

/** Resolves the bounded media-understanding task concurrency from config. */
export function resolveConcurrency(cfg: OpenClawConfig): number {
  const configured = cfg.tools?.media?.concurrency;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_MEDIA_CONCURRENCY;
}
