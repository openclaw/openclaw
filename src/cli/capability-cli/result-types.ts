import type { NormalizedUsage } from "../../agents/usage.js";

export type CapabilityTransport = "local" | "gateway";

export type CapabilityEnvelope = {
  ok: boolean;
  capability: string;
  transport: CapabilityTransport;
  provider?: string;
  model?: string;
  usage?: NormalizedUsage;
  lastCallUsage?: NormalizedUsage;
  attempts: Array<Record<string, unknown>>;
  inputs?: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
  ignoredOverrides?: Array<Record<string, unknown>>;
  error?: string;
};
