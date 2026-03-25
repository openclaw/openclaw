import { createHash } from "node:crypto";

function buildDeterministicTraceId(seed: string): string {
  return createHash("sha256").update(`d0-trace:${seed}`).digest("hex").slice(0, 32);
}

function buildDeterministicSpanId(seed: string): string {
  return createHash("sha256").update(`d0-span:${seed}`).digest("hex").slice(0, 16);
}

export function buildD0RunTraceparent(runId: string): string {
  return `00-${buildDeterministicTraceId(runId)}-${buildDeterministicSpanId(runId)}-01`;
}
