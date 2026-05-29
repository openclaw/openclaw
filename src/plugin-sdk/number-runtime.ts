// Numeric coercion helpers for plugin runtime inputs.

export {
  asFiniteNumberInRange,
  parseFiniteNumber,
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
  parseStrictInteger,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  positiveSecondsToSafeMilliseconds,
  nonNegativeSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromEpochSeconds,
} from "../shared/number-coercion.js";
export { MAX_TCP_PORT, parseTcpPort } from "../infra/tcp-port.js";
