import type { PluginHookName } from "./hook-types.js";

export type ReflexGateAction = {
  kind: string;
  name: string;
  args: Record<string, unknown>;
  raw?: unknown;
};

export type ReflexGateState = {
  session_id: string;
  turn_id: string;
  features: Record<string, unknown>;
};

export type ReflexGateVerdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "rewrite"; action: ReflexGateAction; reason: string };

export type ReflexGateDecision = {
  weave_id: string;
  hook: string;
  joinpoint: string;
  verdict: ReflexGateVerdict;
  enforcement: "hard";
  by: string[];
  fail_mode: "deny" | "allow";
  degraded?: boolean;
  record?: unknown;
};

export type ReflexGateContext = {
  hook: PluginHookName;
  action: ReflexGateAction;
  state: ReflexGateState;
  joinpoint?: string;
  failMode?: "deny" | "allow";
};

export type ReflexGate = {
  hook: PluginHookName;
  joinpoint: string;
  mediate: (
    ctx: ReflexGateContext,
    deadlineMs: number,
  ) => ReflexGateDecision | Promise<ReflexGateDecision>;
};

export type ReflexGateRegistration = ReflexGate & {
  pluginId: string;
  priority?: number;
  source?: string;
};

export function isReflexGateDecision(value: unknown): value is ReflexGateDecision {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  return (
    record.enforcement === "hard" &&
    verdict !== null &&
    typeof verdict === "object" &&
    typeof (verdict as { kind?: unknown }).kind === "string"
  );
}
