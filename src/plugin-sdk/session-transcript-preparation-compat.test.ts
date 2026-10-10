import { expectTypeOf, it } from "vitest";
import type {
  CodexSessionTranscriptMirrorWriteContext,
  CodexSessionTranscriptMirrorWriteLockContext,
} from "./codex-session-transcript-runtime.js";
import type {
  SessionTranscriptAppendMessageParams,
  SessionTranscriptAppendMessagesParams,
  SessionTranscriptWriteContext,
  SessionTranscriptWriteLockContext,
} from "./session-transcript-runtime.js";

it("retains legacy locked types and exposes preparation-only optimistic writes", () => {
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
  type PreparedOptions = Parameters<SessionTranscriptWriteContext["appendMessage"]>[0];
  type PreparedSequenced = Parameters<
    CodexSessionTranscriptMirrorWriteContext["appendMessageWithMessageSequence"]
  >[0];
  expectTypeOf<PreparedSequenced>().toEqualTypeOf<PreparedOptions>();
  expectTypeOf<PreparedOptions>().not.toHaveProperty("prepareMessageAfterIdempotencyCheck");
  expectTypeOf<PreparedOptions>().not.toHaveProperty("beforeFreshMessageCommit");
  expectTypeOf<NonNullable<PreparedOptions["preparation"]>["prepareMessage"]>().toEqualTypeOf<
    ((message: unknown) => Promise<unknown>) | undefined
  >();
  expectTypeOf<PreparedOptions["preparation"]>().toEqualTypeOf<
    SessionTranscriptAppendMessageParams<unknown>["preparation"]
  >();
  expectTypeOf<
    SessionTranscriptAppendMessagesParams<unknown>["messages"][number]
  >().not.toHaveProperty("preparation");
});
