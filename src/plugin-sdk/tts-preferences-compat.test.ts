import { expectTypeOf, it } from "vitest";
import type { resolveTtsPrefsPath as resolveAgentTtsPrefsPath } from "./agent-runtime.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { ReplyPayload } from "./reply-payload.js";
import type {
  buildTtsSystemPromptHint,
  maybeApplyTtsToPayload,
  ResolvedTtsConfig,
  resolveTtsPrefsPath,
} from "./tts-runtime.js";

it("retains the TTS call signatures from the released Plugin SDK", () => {
  type ReleasedPathResolver = (config: ResolvedTtsConfig) => string;
  expectTypeOf<typeof resolveTtsPrefsPath>().toExtend<ReleasedPathResolver>();
  expectTypeOf<typeof resolveAgentTtsPrefsPath>().toExtend<ReleasedPathResolver>();
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
});
