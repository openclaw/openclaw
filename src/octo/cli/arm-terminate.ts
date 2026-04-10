// Octopus Orchestrator -- `openclaw octo arm terminate` CLI command (M1-22)
//
// Thin wrapper over OctoGatewayHandlers.armTerminate. Takes arm_id + --reason
// as arguments. Calls armTerminate on the gateway handler. On success: prints
// "Arm <arm_id> terminated." and exits 0. On HandlerError("not_found") or
// HandlerError("invalid_state"): prints error and exits 1. --json mode outputs
// the OctoArmTerminateResponse as JSON.
//
// Architecture:
//   runArmTerminate  -- composes handler call + output, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { HandlerError, type OctoGatewayHandlers } from "../wire/gateway-handlers.ts";
import type { OctoArmTerminateResponse } from "../wire/methods.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArmTerminateOptions {
  arm_id: string;
  reason: string;
  force?: boolean;
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────

export interface ArmTerminateValidationError {
  ok: false;
  message: string;
}

export interface ArmTerminateValidationOk {
  ok: true;
}

export type ArmTerminateValidationResult = ArmTerminateValidationOk | ArmTerminateValidationError;

/** Validates that required fields are present and non-empty. */
export function validateArmTerminateOptions(
  opts: Partial<ArmTerminateOptions>,
): ArmTerminateValidationResult {
  if (opts.arm_id === undefined || opts.arm_id.trim().length === 0) {
    return { ok: false, message: "arm_id is required" };
  }
  if (opts.reason === undefined || opts.reason.trim().length === 0) {
    return { ok: false, message: "--reason is required" };
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Format -- human-readable
// ──────────────────────────────────────────────────────────────────────────

/** Formats a successful terminate response for human display. */
export function formatArmTerminate(response: OctoArmTerminateResponse): string {
  return `Arm ${response.arm_id} terminated.\n`;
}

// ──────────────────────────────────────────────────────────────────────────
// Format -- JSON
// ──────────────────────────────────────────────────────────────────────────

/** Formats the terminate response as JSON. */
export function formatArmTerminateJson(response: OctoArmTerminateResponse): string {
  return JSON.stringify(response, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point called by the CLI dispatcher. Returns exit code (0 = success). */
export async function runArmTerminate(
  handlers: OctoGatewayHandlers,
  opts: ArmTerminateOptions,
  out: { write: (s: string) => void } = process.stdout,
  errOut: { write: (s: string) => void } = process.stderr,
): Promise<number> {
  // Validate required fields.
  const validation = validateArmTerminateOptions(opts);
  if (!validation.ok) {
    errOut.write(`Error: ${validation.message}\n`);
    return 1;
  }

  try {
    const response = await handlers.armTerminate({
      idempotency_key: `cli-terminate-${opts.arm_id}-${Date.now()}`,
      arm_id: opts.arm_id,
      reason: opts.reason,
      force: opts.force,
    });

    const output = opts.json ? formatArmTerminateJson(response) : formatArmTerminate(response);
    out.write(output);
    return 0;
  } catch (err) {
    if (err instanceof HandlerError) {
      if (err.code === "not_found") {
        errOut.write(`Error: arm not found: ${opts.arm_id}\n`);
        return 1;
      }
      if (err.code === "invalid_state") {
        errOut.write(`Error: ${err.message}\n`);
        return 1;
      }
    }
    throw err;
  }
}
