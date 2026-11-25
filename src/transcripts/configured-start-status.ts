import {
  TRANSCRIPTS_PAGE_MAX,
  type TranscriptsStatusResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";

type StartDiagnostic = NonNullable<
  TranscriptsStatusResult["configuredSources"][number]["startDiagnostic"]
>;
type StartFact = { lifecycleToken: symbol; diagnostic?: StartDiagnostic };

// One Gateway service owns this bounded process snapshot. It is never persisted
// or used to authorize capture, stop, or recovery of an archived session.
let current: Map<number, StartFact> | undefined;

export function beginConfiguredTranscriptStarts() {
  const owner = new Map<number, StartFact>();
  current = owner;
  return {
    record(index: number, lifecycleToken: symbol, diagnostic?: StartDiagnostic) {
      if (current === owner && index < TRANSCRIPTS_PAGE_MAX) {
        owner.set(index, { lifecycleToken, diagnostic });
      }
    },
    clear() {
      if (current === owner) {
        current = undefined;
      }
    },
  };
}

export function readConfiguredTranscriptStarts(): ReadonlyMap<number, StartFact> | undefined {
  return current;
}
