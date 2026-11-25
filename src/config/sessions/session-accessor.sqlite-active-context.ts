import {
  createSessionTranscriptActiveContextReader,
  type SessionTranscriptActiveContextReadOptions,
} from "./session-accessor.sqlite-active-context-read.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import type { CurrentTranscriptProjection } from "./session-accessor.sqlite-projection-read.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope-helpers.js";

type ActiveContextReadOptions = SessionTranscriptActiveContextReadOptions & {
  readOnly?: boolean;
  resolvedScope?: ResolvedTranscriptReadScope;
  transaction?: CurrentTranscriptProjection["database"];
};

/** Read an active branch bounded by replay limits or the complete compaction window. */
export function readSessionTranscriptBoundedActiveContextCore(
  scope: SessionTranscriptReadScope,
  options: ActiveContextReadOptions,
): SessionTranscriptBoundedActiveContext {
  return readActiveContext(scope, options, true);
}

/** Plan the same window without retaining message bodies in the hydration worker. */
export function readSessionTranscriptCompactionPlan(
  scope: SessionTranscriptReadScope,
  options: ActiveContextReadOptions,
): Omit<SessionTranscriptBoundedActiveContext, "events"> {
  const { events: _events, ...metadata } = readActiveContext(scope, options, false);
  return metadata;
}

function readActiveContext(
  scope: SessionTranscriptReadScope,
  options: ActiveContextReadOptions,
  materializeEvents: boolean,
): SessionTranscriptBoundedActiveContext {
  return withCurrentProjectionSnapshot(
    scope,
    createSessionTranscriptActiveContextReader(options, materializeEvents),
    {
      readOnly: options.readOnly,
      resolvedScope: options.resolvedScope,
      transaction: options.transaction,
    },
  );
}
