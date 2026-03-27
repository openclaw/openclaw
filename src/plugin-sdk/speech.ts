// Public speech helpers for bundled or third-party plugins.

import { parseTtsDirectives as parseTtsDirectivesImpl } from "../tts/directives.js";

export type {
  SpeechModelOverridePolicy,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../tts/provider-types.js";

export const parseTtsDirectives = parseTtsDirectivesImpl;
