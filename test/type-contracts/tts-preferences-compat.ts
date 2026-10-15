import { expectTypeOf } from "vitest";
import type { resolveTtsPrefsPath as resolveAgentTtsPrefsPath } from "../../src/plugin-sdk/agent-runtime.js";
import type { OpenClawConfig } from "../../src/plugin-sdk/config-contracts.js";
import type { ReplyPayload } from "../../src/plugin-sdk/reply-payload.js";
import type { PluginRuntime } from "../../src/plugin-sdk/runtime-store.js";
import type {
  buildTtsSystemPromptHint,
  buildTtsSystemPromptHintAsync,
  maybeApplyTtsToPayload,
  prepareTtsPreferences,
  PreparedTtsPreferences,
  ResolvedTtsConfig,
  resolveTtsPrefsPath,
} from "../../src/plugin-sdk/tts-runtime.js";

// Retains the TTS call signatures from the released Plugin SDK.
type ReleasedPathResolver = (config: ResolvedTtsConfig) => string;
expectTypeOf<typeof resolveTtsPrefsPath>().toExtend<ReleasedPathResolver>();
expectTypeOf<typeof resolveAgentTtsPrefsPath>().toExtend<ReleasedPathResolver>();
expectTypeOf<
  typeof prepareTtsPreferences
>().returns.resolves.toEqualTypeOf<PreparedTtsPreferences>();
expectTypeOf<typeof buildTtsSystemPromptHintAsync>().parameters.toEqualTypeOf<
  Parameters<typeof buildTtsSystemPromptHint>
>();
expectTypeOf<typeof buildTtsSystemPromptHintAsync>().returns.resolves.toEqualTypeOf<
  ReturnType<typeof buildTtsSystemPromptHint>
>();
expectTypeOf<PluginRuntime["tts"]["buildSystemPromptHintAsync"]>().toEqualTypeOf<
  typeof buildTtsSystemPromptHintAsync | undefined
>();
expectTypeOf<Omit<PluginRuntime["tts"], "buildSystemPromptHintAsync">>().toExtend<
  PluginRuntime["tts"]
>();
expectTypeOf<typeof buildTtsSystemPromptHint>().toExtend<
  (
    cfg: OpenClawConfig,
    agentId?: string,
    options?: { messageToolOnly?: boolean },
  ) => string | undefined
>();
expectTypeOf<typeof maybeApplyTtsToPayload>().toExtend<
  (params: {
    payload: ReplyPayload;
    cfg: OpenClawConfig;
    channel?: string;
    kind?: "tool" | "block" | "final";
    inboundAudio?: boolean;
    ttsAuto?: string;
    agentId?: string;
    accountId?: string;
  }) => Promise<ReplyPayload>
>();
