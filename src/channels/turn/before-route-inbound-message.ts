/**
 * `before_route_inbound_message` — P4 runtime hook for the preflight-v1 gate.
 *
 * Contract: docs/contracts/preflight-v1.md (owned by the openclaw-gateway
 * repo; this module is the runtime-side invocation at the inbound-routing
 * seam). Per inbound message, before any LLM call lands, the hook invokes the
 * preflight gate's `evaluate` and maps its exit code onto the turn admission:
 *
 *   exit 0  -> ALLOW  -> proceed to routing
 *   exit 1  -> REJECT -> block the invocation (fail-closed)
 *   exit 2  -> CONFIG/USAGE error -> block + operator alert (fail-closed)
 *   any other non-zero exit -> block (never allow-everything)
 *
 * The gate itself emits the `preflight.decision.v1` envelope on stdout and
 * appends it to the event log (`--event-log`), so this hook never synthesizes
 * its own audit record. When the gate is not configured (script absent), the
 * hook degrades to a no-op and unconfigured installs are unaffected.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type {
  BeforeRouteInboundMessageTurnOptions,
  PreflightDecisionEvent,
  PreflightGateClient,
  PreflightGateDecision,
  PreflightGateInvocation,
  PreflightGateOutcome,
  PreflightGateSpawn,
} from "./preflight-gate-contract.js";
import type { ChannelTurnAdmission } from "./types.js";

export const BEFORE_ROUTE_INBOUND_MESSAGE_HOOK = "before_route_inbound_message" as const;

/** Env var carrying the preflight-gate.py path (deploy pipeline injects it). */
export const PREFLIGHT_GATE_ENV = "PREFLIGHT_GATE" as const;

/** Env var for the event log path; defaults under ~/.openclaw/preflight/<env>/. */
export const PREFLIGHT_EVENT_LOG_ENV = "PREFLIGHT_EVENT_LOG" as const;

/** Exit codes defined by the preflight-v1 contract (any non-zero blocks). */
export const PREFLIGHT_GATE_EXIT_ALLOW = 0 as const;
export const PREFLIGHT_GATE_EXIT_REJECT = 1 as const;
export const PREFLIGHT_GATE_EXIT_CONFIG_ERROR = 2 as const;

function isPreflightDecisionEvent(value: unknown): value is PreflightDecisionEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("event" in value) || value.event !== "preflight.decision.v1") {
    return false;
  }
  if (!("decision" in value) || (value.decision !== "allow" && value.decision !== "reject")) {
    return false;
  }
  return true;
}

function parsePreflightDecisionEvent(stdout: string): PreflightDecisionEvent | null {
  const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(firstLine);
    return isPreflightDecisionEvent(value) ? value : null;
  } catch {
    return null;
  }
}

export function classifyPreflightGateExit(exitCode: number): PreflightGateDecision {
  if (exitCode === PREFLIGHT_GATE_EXIT_ALLOW) {
    return "allow";
  }
  if (exitCode === PREFLIGHT_GATE_EXIT_REJECT) {
    return "reject";
  }
  return "config-error";
}

/** Resolve the gate script path from `PREFLIGHT_GATE` or a dev-checkout default. */
export function resolvePreflightGatePath(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = env[PREFLIGHT_GATE_ENV]?.trim();
  if (explicit) {
    return explicit;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const candidate = path.join(repoRoot, "scripts", "preflight-gate.py");
  return fs.existsSync(candidate) ? candidate : null;
}

/** Default event log location: ~/.openclaw/preflight/<env>/preflight-decisions.jsonl. */
export function resolveDefaultPreflightEventLog(
  env: Record<string, string | undefined> = process.env,
): string {
  const scope = env.NODE_ENV ?? "development";
  return path.join(os.homedir(), ".openclaw", "preflight", scope, "preflight-decisions.jsonl");
}

function defaultSpawn(python: string): PreflightGateSpawn {
  const run = promisify(execFile);
  return async (args) => {
    try {
      const { stdout, stderr } = await run(python, [...args], { maxBuffer: 1024 * 1024 });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "number"
          ? error.code
          : 1;
      const message = toStringifiedError(error).message;
      const stdout =
        typeof error === "object" && error !== null && "stdout" in error
          ? typeof error.stdout === "string"
            ? error.stdout
            : ""
          : "";
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? typeof error.stderr === "string"
            ? error.stderr
            : message
          : message;
      return { exitCode: code, stdout, stderr };
    }
  };
}

export function buildPreflightGateEvaluateArgs(invocation: PreflightGateInvocation): string[] {
  const args = ["evaluate"];
  if (invocation.actor) {
    args.push("--actor", invocation.actor);
  }
  if (invocation.agent) {
    args.push("--agent", invocation.agent);
  }
  if (invocation.capability) {
    args.push("--capability", invocation.capability);
  }
  if (invocation.route) {
    args.push("--route", invocation.route);
  }
  const tenant = invocation.tenant;
  if (tenant?.jwt) {
    args.push("--tenant-jwt", tenant.jwt);
  }
  if (tenant?.audience) {
    args.push("--audience", tenant.audience);
  }
  if (tenant?.counterpartyId) {
    args.push("--counterparty-id", tenant.counterpartyId);
  }
  if (tenant?.clientId) {
    args.push("--client-id", tenant.clientId);
  }
  if (tenant?.projectId) {
    args.push("--project-id", tenant.projectId);
  }
  if (invocation.consentFile) {
    args.push("--consent-file", invocation.consentFile);
  }
  if (invocation.postureFile) {
    args.push("--posture-file", invocation.postureFile);
  }
  if (invocation.principals) {
    args.push("--principals", invocation.principals);
  }
  if (invocation.eventLog) {
    args.push("--event-log", invocation.eventLog);
  }
  return args;
}

export function createPreflightGateClient(options?: {
  gatePath?: string;
  python?: string;
  spawn?: PreflightGateSpawn;
}): PreflightGateClient {
  const gatePath = options?.gatePath ?? resolvePreflightGatePath();
  const python = options?.python ?? "python3";
  const spawn = options?.spawn ?? defaultSpawn(python);
  const configured = gatePath !== null && fs.existsSync(gatePath);
  return {
    configured,
    async invoke(invocation: PreflightGateInvocation): Promise<PreflightGateOutcome> {
      if (!configured) {
        return {
          exitCode: PREFLIGHT_GATE_EXIT_CONFIG_ERROR,
          decision: "config-error",
          event: null,
          stderr: "preflight gate is not configured",
        };
      }
      const scriptArgs = buildPreflightGateEvaluateArgs(invocation);
      // `configured` is true only when gatePath is a non-null existing path.
      // SAFETY: this branch is unreachable when gatePath is null.
      const result = await spawn([gatePath as string, ...scriptArgs]);
      return {
        exitCode: result.exitCode,
        decision: classifyPreflightGateExit(result.exitCode),
        event: parsePreflightDecisionEvent(result.stdout),
        stderr: result.stderr || undefined,
      };
    },
  };
}

/**
 * Run the pre-route gate seam for one inbound message. Returns a terminal
 * admission (`drop`) when the gate blocks, or `null` to proceed to routing.
 * Unconfigured gates are a no-op: `null`, no subprocess, no events.
 */
export async function runBeforeRouteInboundMessage(
  options: BeforeRouteInboundMessageTurnOptions,
): Promise<ChannelTurnAdmission | null> {
  if (!options.gate.configured) {
    return null;
  }
  const outcome = await options.gate.invoke({
    actor: options.actor,
    agent: options.agent,
    capability: options.capability,
    route: options.route,
    eventLog: options.eventLog ?? resolveDefaultPreflightEventLog(),
  });
  if (outcome.decision === "allow") {
    return null;
  }
  return outcome.decision === "reject"
    ? { kind: "drop", reason: "preflight" }
    : { kind: "drop", reason: "preflight-config" };
}
