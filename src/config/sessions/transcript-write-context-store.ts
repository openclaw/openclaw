import { AsyncContext } from "../../shared/async-context.js";
import { runWithCliHistoryWriter } from "./cli-history-boundary.js";
import type {
  OwnedSessionTranscriptWriteContext,
  TranscriptSourcePublication,
} from "./transcript-write-context.js";

export const ownedTranscriptWriteContext = new AsyncContext<
  OwnedSessionTranscriptWriteContext & { sourcePublication?: TranscriptSourcePublication }
>(Symbol("ownedTranscriptWriteContext"));

/** Runs detached work without retaining an attempt-owned transcript context. */
export function runWithoutOwnedSessionTranscriptWrites<T>(run: () => T): T {
  return ownedTranscriptWriteContext.exit(() => runWithCliHistoryWriter(undefined, run));
}
