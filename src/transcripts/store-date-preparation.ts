import {
  parseDateStringTimestampMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { TRANSCRIPTS_RESULT_MAX_BYTES } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";

/** Native Date parsing belongs to the caller: skills can temporarily change its timezone. */
export function prepareTranscriptDateReader(assertOwner: () => void, databasePath: string) {
  const timezone = process.env.TZ;
  let usedCallerTimezone = false;
  const assertCurrent = () => {
    assertOwner();
    if (usedCallerTimezone && process.env.TZ !== timezone) {
      throw new Error("Transcript timezone changed while reading; retry the read.");
    }
  };
  return {
    assertCurrent,
    createAdmission: () => ({
      nativeLocations: [databasePath],
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        const facts = request.facts;
        if (
          request.stage !== "prepare" ||
          !isRecord(facts) ||
          facts.kind !== "transcript-date" ||
          typeof facts.value !== "string" ||
          Buffer.byteLength(facts.value, "utf8") > TRANSCRIPTS_RESULT_MAX_BYTES ||
          !(facts.result instanceof SharedArrayBuffer) ||
          facts.result.byteLength !== Float64Array.BYTES_PER_ELEMENT
        ) {
          throw new Error("Invalid transcript date preparation request");
        }
        usedCallerTimezone = true;
        assertCurrent();
        new Float64Array(facts.result)[0] = parseDateStringTimestampMs(facts.value) ?? Number.NaN;
        grant();
      }),
    }),
  };
}

/** Reuse one bounded reply and cache across the current synchronous query only. */
export function createPreparedTranscriptDateReader() {
  const result = new Float64Array(new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT));
  const dates = new Map<string, number | undefined>();
  return (value: unknown): number | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    if (dates.has(value)) {
      return dates.get(value);
    }
    const nativeTimestamp = parseDateStringTimestampMs(value);
    // Canonical UTC output is independent of either isolate's local timezone.
    if (nativeTimestamp !== undefined && timestampMsToIsoString(nativeTimestamp) === value) {
      return nativeTimestamp;
    }
    requestSqliteWorkerOperationAdmission({
      stage: "prepare",
      facts: { kind: "transcript-date", value, result: result.buffer },
    });
    const parsed = Number.isNaN(result[0]) ? undefined : result[0];
    if (value.length <= 256) {
      if (dates.size === 256) {
        dates.clear();
      }
      dates.set(value, parsed);
    }
    return parsed;
  };
}
