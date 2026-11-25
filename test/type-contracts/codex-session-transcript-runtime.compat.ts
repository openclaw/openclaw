import { expectTypeOf } from "vitest";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "../../src/config/sessions/session-accessor.types.js";
import type { AgentMessage } from "../../src/plugin-sdk/agent-core.js";
import type {
  readCodexSessionContext,
  validateCodexSessionTranscriptReadAdmission,
  validateCodexSessionTranscriptContextVersion,
  SessionTranscriptContextVersion,
} from "../../src/plugin-sdk/codex-session-transcript-runtime.js";
import type { TranscriptTurnAdmission } from "../../src/plugin-sdk/session-transcript-runtime.js";

// Retains the v2026.9.8 synchronous Codex reader and validator signatures.
type ReleasedReader = <T>(
  target: SessionTranscriptRuntimeTarget,
  read: (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => T,
  admission?: TranscriptTurnAdmission,
) => T;

expectTypeOf<typeof readCodexSessionContext>().toExtend<ReleasedReader>();
expectTypeOf<ReturnType<typeof readCodexSessionContext<string>>>().toEqualTypeOf<string>();
expectTypeOf<typeof validateCodexSessionTranscriptReadAdmission>().toEqualTypeOf<
  (scope: SessionTranscriptReadScope, admission: TranscriptTurnAdmission | undefined) => void
>();
expectTypeOf<typeof validateCodexSessionTranscriptContextVersion>().toEqualTypeOf<
  (scope: SessionTranscriptReadScope, version: SessionTranscriptContextVersion | undefined) => void
>();
