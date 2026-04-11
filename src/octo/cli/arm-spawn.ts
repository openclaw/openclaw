// Octopus Orchestrator -- `openclaw octo arm spawn` CLI command
//
// Spawns a new arm by building an ArmSpec and calling
// OctoGatewayHandlers.armSpawn. Supports two input modes:
//
//   1. --spec-file <path>  — read a complete ArmSpec JSON file (power-user)
//   2. Individual flags    — build an ArmSpec from CLI options
//
// Architecture:
//   validateArmSpawnOptions  -- guards required fields present
//   buildArmSpecFromOptions  -- constructs ArmSpec from CLI flags
//   formatArmSpawn           -- human-readable success output
//   formatArmSpawnJson       -- JSON success output
//   runArmSpawn              -- composes validation + handler call + output
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { readFileSync } from "node:fs";
import { HandlerError, type OctoGatewayHandlers } from "../wire/gateway-handlers.ts";
import type { OctoArmSpawnResponse } from "../wire/methods.ts";
import type { AdapterType } from "../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArmSpawnOptions {
  // Full-spec mode
  specFile?: string;

  // Individual-flag mode
  mission?: string;
  adapter?: string;
  runtime?: string;
  agentId?: string;
  cwd?: string;
  initialInput?: string;
  habitat?: string;
  capabilities?: string[];
  worktreePath?: string;
  policyProfile?: string;
  labels?: string[];
  idempotencyKey?: string;

  // Runtime options (adapter-specific, passed through)
  command?: string;
  args?: string[];
  model?: string;

  // Output
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────

export interface ArmSpawnValidationError {
  ok: false;
  message: string;
}

export interface ArmSpawnValidationOk {
  ok: true;
}

export type ArmSpawnValidationResult = ArmSpawnValidationOk | ArmSpawnValidationError;

/** Validates that required fields are present. */
export function validateArmSpawnOptions(opts: ArmSpawnOptions): ArmSpawnValidationResult {
  // spec-file mode: only the file path is required
  if (opts.specFile !== undefined) {
    if (opts.specFile.trim().length === 0) {
      return { ok: false, message: "--spec-file path must not be empty" };
    }
    return { ok: true };
  }

  // Individual-flag mode: require the essential fields
  if (!opts.mission || opts.mission.trim().length === 0) {
    return { ok: false, message: "--mission is required" };
  }
  if (!opts.adapter || opts.adapter.trim().length === 0) {
    return { ok: false, message: "--adapter is required" };
  }
  const validAdapters = ["structured_subagent", "cli_exec", "pty_tmux", "structured_acp"];
  if (!validAdapters.includes(opts.adapter)) {
    return {
      ok: false,
      message: `--adapter must be one of: ${validAdapters.join(", ")} (got "${opts.adapter}")`,
    };
  }
  if (!opts.runtime || opts.runtime.trim().length === 0) {
    return { ok: false, message: "--runtime is required" };
  }
  if (!opts.agentId || opts.agentId.trim().length === 0) {
    return { ok: false, message: "--agent-id is required" };
  }
  if (!opts.cwd || opts.cwd.trim().length === 0) {
    return { ok: false, message: "--cwd is required" };
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// ArmSpec construction from CLI flags
// ──────────────────────────────────────────────────────────────────────────

/** Builds an ArmSpec object from individual CLI flags. */
export function buildArmSpecFromOptions(opts: ArmSpawnOptions): Record<string, unknown> {
  const adapterType = opts.adapter as AdapterType;
  const idempotencyKey = opts.idempotencyKey ?? `cli-spawn-${Date.now()}`;

  const spec: Record<string, unknown> = {
    spec_version: 1,
    mission_id: opts.mission,
    adapter_type: adapterType,
    runtime_name: opts.runtime,
    agent_id: opts.agentId,
    cwd: opts.cwd,
    idempotency_key: idempotencyKey,
    runtime_options: buildRuntimeOptions(adapterType, opts),
  };

  if (opts.initialInput !== undefined) {
    spec.initial_input = opts.initialInput;
  }
  if (opts.habitat !== undefined) {
    spec.desired_habitat = opts.habitat;
  }
  if (opts.capabilities !== undefined && opts.capabilities.length > 0) {
    spec.desired_capabilities = opts.capabilities;
  }
  if (opts.worktreePath !== undefined) {
    spec.worktree_path = opts.worktreePath;
  }
  if (opts.policyProfile !== undefined) {
    spec.policy_profile_ref = opts.policyProfile;
  }
  if (opts.labels !== undefined && opts.labels.length > 0) {
    spec.labels = parseLabels(opts.labels);
  }

  return spec;
}

/** Builds adapter-specific runtime_options from CLI flags. */
function buildRuntimeOptions(
  adapterType: AdapterType,
  opts: ArmSpawnOptions,
): Record<string, unknown> {
  switch (adapterType) {
    case "pty_tmux": {
      const ro: Record<string, unknown> = {};
      if (opts.command !== undefined) {
        ro.command = opts.command;
      } else {
        ro.command = "bash";
      }
      if (opts.args !== undefined && opts.args.length > 0) {
        ro.args = opts.args;
      }
      return ro;
    }
    case "cli_exec": {
      const ro: Record<string, unknown> = {};
      if (opts.command !== undefined) {
        ro.command = opts.command;
      } else {
        ro.command = "bash";
      }
      if (opts.args !== undefined && opts.args.length > 0) {
        ro.args = opts.args;
      }
      return ro;
    }
    case "structured_subagent": {
      const ro: Record<string, unknown> = {};
      if (opts.model !== undefined) {
        ro.model = opts.model;
      }
      return ro;
    }
    case "structured_acp": {
      const ro: Record<string, unknown> = {};
      if (opts.command !== undefined) {
        ro.acpxHarness = opts.command;
      }
      if (opts.model !== undefined) {
        ro.model = opts.model;
      }
      return ro;
    }
    default:
      return {};
  }
}

/** Parses label strings ("key=value") into a Record. */
function parseLabels(labels: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const label of labels) {
    const eqIdx = label.indexOf("=");
    if (eqIdx === -1) {
      result[label] = "";
    } else {
      result[label.slice(0, eqIdx)] = label.slice(eqIdx + 1);
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Format -- human-readable
// ──────────────────────────────────────────────────────────────────────────

/** Formats a successful spawn response for human display. */
export function formatArmSpawn(response: OctoArmSpawnResponse): string {
  const lines: string[] = [];
  lines.push(`Arm spawned successfully.`);
  lines.push(``);
  lines.push(`  arm_id:  ${response.arm_id}`);
  if (response.session_ref.tmux_session_name) {
    lines.push(`  tmux:    ${response.session_ref.tmux_session_name}`);
  }
  if (response.session_ref.cwd) {
    lines.push(`  cwd:     ${response.session_ref.cwd}`);
  }
  if (response.session_ref.attach_command) {
    lines.push(`  attach:  ${response.session_ref.attach_command}`);
  }
  lines.push(``);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Format -- JSON
// ──────────────────────────────────────────────────────────────────────────

/** Formats the spawn response as JSON. */
export function formatArmSpawnJson(response: OctoArmSpawnResponse): string {
  return JSON.stringify(response, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point called by the CLI dispatcher. Returns exit code (0 = success). */
export async function runArmSpawn(
  handlers: OctoGatewayHandlers,
  opts: ArmSpawnOptions,
  out: { write: (s: string) => void } = process.stdout,
  errOut: { write: (s: string) => void } = process.stderr,
): Promise<number> {
  // Validate required fields.
  const validation = validateArmSpawnOptions(opts);
  if (!validation.ok) {
    errOut.write(`Error: ${validation.message}\n`);
    return 1;
  }

  // Build the ArmSpec — either from a file or from individual flags.
  let spec: unknown;
  if (opts.specFile !== undefined) {
    try {
      const raw = readFileSync(opts.specFile, "utf-8");
      spec = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errOut.write(`Error: failed to read spec file: ${msg}\n`);
      return 1;
    }
  } else {
    spec = buildArmSpecFromOptions(opts);
  }

  // Derive the idempotency key.
  const idempotencyKey =
    ((spec as Record<string, unknown>).idempotency_key as string | undefined) ??
    opts.idempotencyKey ??
    `cli-spawn-${Date.now()}`;

  try {
    const response = await handlers.armSpawn({
      idempotency_key: idempotencyKey,
      spec,
    });

    const output = opts.json ? formatArmSpawnJson(response) : formatArmSpawn(response);
    out.write(output);
    return 0;
  } catch (err) {
    if (err instanceof HandlerError) {
      if (err.code === "invalid_spec") {
        errOut.write(`Error: invalid ArmSpec: ${err.message}\n`);
        return 1;
      }
      if (err.code === "tmux_failed") {
        errOut.write(`Error: tmux session creation failed: ${err.message}\n`);
        return 1;
      }
      if (err.code === "policy_denied") {
        errOut.write(`Error: policy denied: ${err.message}\n`);
        return 1;
      }
      if (err.code === "conflict") {
        errOut.write(`Error: conflict (duplicate idempotency key?): ${err.message}\n`);
        return 1;
      }
      errOut.write(`Error: ${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
