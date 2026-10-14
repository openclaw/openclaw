// Numeric coercion helpers for plugin runtime inputs.

export { addSafeTimeoutDelayGraceMs } from "../utils/timer-delay.js";
export { formatByteSize } from "../../packages/normalization-core/src/format.js";
export {
  asDateTimestampMs,
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
  asFiniteNumberInRange,
  asSafeIntegerInRange,
  isFutureDateTimestampMs,
  parseDateFirstTimestampMs,
  parseDateStringTimestampMs,
  parseFiniteNumber,
  clampTimerTimeoutMs,
  clampPositiveTimerTimeoutMs,
  addTimerTimeoutGraceMs,
  resolvePositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
  MAX_TIMER_TIMEOUT_SECONDS,
  MAX_DATE_TIMESTAMP_MS,
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
  parseStrictInteger,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  positiveSecondsToSafeMilliseconds,
  nonNegativeSecondsToSafeMilliseconds,
  resolveDateTimestampMs,
  resolveTimestampMsToIsoString,
  timestampMsToIsoString,
  resolveExpiresAtMsFromDurationMs,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromDurationOrEpoch,
  resolveExpiresAtMsFromEpochSeconds,
} from "../../packages/normalization-core/src/number-coercion.js";
export { MAX_TCP_PORT, parseTcpPort } from "../infra/tcp-port.js";

// Private observed-message policy shared by official channel implementations.
export { resolvePromptHistoryLimit } from "../auto-reply/reply/history-limit.js";
