// Fixed-vocabulary Gateway startup outcomes keep normal boot logs useful
// without exposing configuration values, paths, or startup errors.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInternalHookSelection } from "../hooks/configured.js";
import { isTruthyEnvValue } from "../infra/env.js";

const GATEWAY_STARTUP_SUBSYSTEMS = [
  "internal-hooks",
  "internal-startup-hook",
  "gateway-start-hooks",
  "gmail-watcher",
  "gmail-model",
] as const;

type GatewayStartupSubsystem = (typeof GATEWAY_STARTUP_SUBSYSTEMS)[number];

type GatewayStartupSkippedReason =
  | "not-configured"
  | "no-handlers-loaded"
  | "disabled-by-environment"
  | "hooks-disabled"
  | "superseded"
  | "no-gmail-account";

type GatewayStartupOutcome =
  | { subsystem: GatewayStartupSubsystem; status: "loaded" | "scheduled" }
  | { subsystem: GatewayStartupSubsystem; status: "failed"; reason: "see earlier log" }
  | {
      subsystem: GatewayStartupSubsystem;
      status: "skipped";
      reason: GatewayStartupSkippedReason;
    };

export type GatewayStartupOutcomeRecorder = {
  record: (outcome: GatewayStartupOutcome) => void;
  snapshot: () => GatewayStartupOutcome[];
};

type GatewayStartupOutcomeRecorderParams = {
  cfg: OpenClawConfig;
  gatewayStartHooks: boolean;
  env?: NodeJS.ProcessEnv;
};

function skipped(
  subsystem: GatewayStartupSubsystem,
  reason: GatewayStartupSkippedReason,
): GatewayStartupOutcome {
  return { subsystem, status: "skipped", reason };
}

/** Create the complete initial outcome set; awaited startup work may replace entries later. */
export function createGatewayStartupOutcomeRecorder(
  params: GatewayStartupOutcomeRecorderParams,
): GatewayStartupOutcomeRecorder {
  const internalHooks =
    params.cfg.hooks?.internal?.enabled === false
      ? "hooks-disabled"
      : resolveInternalHookSelection(params.cfg).configured
        ? "no-handlers-loaded"
        : "not-configured";
  const gmailWatcher = !params.cfg.hooks?.enabled
    ? "hooks-disabled"
    : !params.cfg.hooks.gmail?.account
      ? "no-gmail-account"
      : isTruthyEnvValue((params.env ?? process.env).OPENCLAW_SKIP_GMAIL_WATCHER)
        ? "disabled-by-environment"
        : "scheduled";

  const initial: GatewayStartupOutcome[] = [
    skipped("internal-hooks", internalHooks),
    skipped(
      "internal-startup-hook",
      internalHooks === "hooks-disabled" ? "hooks-disabled" : "no-handlers-loaded",
    ),
    params.gatewayStartHooks
      ? { subsystem: "gateway-start-hooks", status: "scheduled" }
      : skipped("gateway-start-hooks", "no-handlers-loaded"),
    gmailWatcher === "scheduled"
      ? { subsystem: "gmail-watcher", status: "scheduled" }
      : skipped("gmail-watcher", gmailWatcher),
    params.cfg.hooks?.gmail?.model
      ? { subsystem: "gmail-model", status: "scheduled" }
      : skipped("gmail-model", "not-configured"),
  ];
  const outcomes = new Map(initial.map((outcome) => [outcome.subsystem, outcome]));

  return {
    record: (outcome) => {
      outcomes.set(outcome.subsystem, outcome);
    },
    snapshot: () =>
      GATEWAY_STARTUP_SUBSYSTEMS.flatMap((subsystem) => {
        const outcome = outcomes.get(subsystem);
        return outcome ? [outcome] : [];
      }),
  };
}

/** Format outcomes in canonical order regardless of collection order. */
export function formatGatewayStartupOutcomes(outcomes: readonly GatewayStartupOutcome[]): string {
  const bySubsystem = new Map(outcomes.map((outcome) => [outcome.subsystem, outcome]));
  const entries = GATEWAY_STARTUP_SUBSYSTEMS.flatMap((subsystem) => {
    const outcome = bySubsystem.get(subsystem);
    if (!outcome) {
      return [];
    }
    const detail = "reason" in outcome ? ` (${outcome.reason})` : "";
    return `${outcome.subsystem}=${outcome.status}${detail}`;
  });
  return `gateway startup outcomes: ${entries.join("; ")}`;
}
