import type { DiagnosticTraceContext } from "./diagnostic-trace-context.js";

/** Internal shared envelope; not a public diagnostic-runtime export. */
export type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
  trace?: DiagnosticTraceContext;
};
