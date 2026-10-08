import { expectTypeOf, it } from "vitest";
import type { CodexSessionTranscriptMirrorWriteLockContext } from "./codex-session-transcript-runtime.js";
import type {
  SessionTranscriptAppendMessageParams,
  SessionTranscriptWriteLockContext,
} from "./session-transcript-runtime.js";

it("retains synchronous locked preparation and adds an awaited companion", () => {
  type Options = Parameters<SessionTranscriptWriteLockContext["appendMessage"]>[0];
  type Sequenced = Parameters<
    CodexSessionTranscriptMirrorWriteLockContext["appendMessageWithMessageSequence"]
  >[0];
  expectTypeOf<NonNullable<Options["prepareMessageAfterIdempotencyCheck"]>>().toEqualTypeOf<
    (message: unknown) => unknown
  >();
  expectTypeOf<NonNullable<Options["prepareMessageAfterIdempotencyCheckAsync"]>>().toEqualTypeOf<
    (message: unknown) => Promise<unknown>
  >();
  expectTypeOf<Sequenced>().toEqualTypeOf<Options>();
  expectTypeOf<SessionTranscriptAppendMessageParams<unknown>>().not.toHaveProperty(
    "prepareMessageAfterIdempotencyCheckAsync",
  );
});
