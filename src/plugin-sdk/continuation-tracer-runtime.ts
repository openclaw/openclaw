// Private official-plugin runtime: the continuation tracer registry the diagnostics
// OpenTelemetry exporter installs its adapter into. Not a third-party plugin contract.

export {
  getContinuationTracer,
  noopTracer,
  resetContinuationTracer,
  setContinuationTracer,
} from "../infra/continuation-tracer.js";
export type {
  Span,
  SpanAttributes,
  SpanAttributeValue,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from "../infra/continuation-tracer.js";
