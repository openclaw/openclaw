import { expectTypeOf, it } from "vitest";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.types.js";
import type { AgentMessage } from "./agent-core.js";
import type {
  readCodexSessionContext,
  validateCodexSessionTranscriptReadAdmission,
  validateCodexSessionTranscriptContextVersion,
  SessionTranscriptContextVersion,
} from "./codex-session-transcript-runtime.js";
import type { TranscriptTurnAdmission } from "./session-transcript-runtime.js";

it("retains the v2026.9.8 synchronous Codex reader and validator signatures", () => {
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
    (
      scope: SessionTranscriptReadScope,
      version: SessionTranscriptContextVersion | undefined,
    ) => void
  >();
});
