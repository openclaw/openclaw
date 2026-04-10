// Octopus Orchestrator — `openclaw octo mission` CLI subcommands (M3-08)
//
// Subcommands: create, show, list, pause, resume, abort.
// Each follows the gather + format + formatJson + run pattern from status.ts.
//
// Architecture:
//   gather*  — queries the registry or invokes a gateway handler, returns structured data
//   format*  — renders human-readable output
//   format*Json — renders JSON snapshot
//   run*     — composes gather + format, writes to output, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type { MissionRecord, RegistryService } from "../head/registry.ts";
import type {
  MissionAbortResponse,
  MissionCreateResponse,
  MissionPauseResponse,
  MissionResumeResponse,
  OctoGatewayHandlers,
} from "../wire/gateway-handlers.ts";

// ──────────────────────────────────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────────────────────────────────

export interface MissionJsonOption {
  json?: boolean;
}

export interface WritableOutput {
  write: (s: string) => void;
}

const defaultOut: WritableOutput = process.stdout;

// ══════════════════════════════════════════════════════════════════════════
// create
// ══════════════════════════════════════════════════════════════════════════

export interface MissionCreateOptions extends MissionJsonOption {
  title: string;
  owner: string;
  gripIds: readonly string[];
  idempotencyKey: string;
  policyProfileRef?: string;
  metadata?: Record<string, unknown>;
}

export interface MissionCreateResult {
  mission_id: string;
  grip_count: number;
}

/** Gather: invoke gateway handler to create a mission. */
export async function gatherMissionCreate(
  handlers: OctoGatewayHandlers,
  opts: MissionCreateOptions,
): Promise<MissionCreateResult> {
  const graph = opts.gripIds.map((grip_id) => ({ grip_id, depends_on: [] as string[] }));
  const response: MissionCreateResponse = await handlers.missionCreate({
    idempotency_key: opts.idempotencyKey,
    mission_spec: {
      spec_version: 1,
      title: opts.title,
      owner: opts.owner,
      graph,
      ...(opts.policyProfileRef !== undefined ? { policy_profile_ref: opts.policyProfileRef } : {}),
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    },
  });
  return { mission_id: response.mission_id, grip_count: response.grip_count };
}

/** Format: human-readable create result. */
export function formatMissionCreate(result: MissionCreateResult): string {
  const lines: string[] = [];
  lines.push(`Mission created: ${result.mission_id}`);
  lines.push(`Grips: ${result.grip_count}`);
  lines.push("");
  return lines.join("\n");
}

/** Format: JSON create result. */
export function formatMissionCreateJson(result: MissionCreateResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

/** Entry point for `openclaw octo mission create`. Returns exit code. */
export async function runMissionCreate(
  handlers: OctoGatewayHandlers,
  opts: MissionCreateOptions,
  out: WritableOutput = defaultOut,
): Promise<number> {
  const result = await gatherMissionCreate(handlers, opts);
  const output = opts.json ? formatMissionCreateJson(result) : formatMissionCreate(result);
  out.write(output);
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════
// show
// ══════════════════════════════════════════════════════════════════════════

export interface MissionShowOptions extends MissionJsonOption {
  missionId: string;
}

export interface MissionShowResult {
  mission: MissionRecord;
}

/** Gather: look up a single mission by id. */
export function gatherMissionShow(
  registry: RegistryService,
  opts: MissionShowOptions,
): MissionShowResult | null {
  const mission = registry.getMission(opts.missionId);
  if (mission === null) {
    return null;
  }
  return { mission };
}

/** Format: human-readable mission detail. */
export function formatMissionShow(result: MissionShowResult): string {
  const m = result.mission;
  const lines: string[] = [];
  lines.push(`Mission: ${m.mission_id}`);
  lines.push(`  Title:   ${m.title}`);
  lines.push(`  Owner:   ${m.owner}`);
  lines.push(`  Status:  ${m.status}`);
  lines.push(`  Version: ${m.version}`);
  lines.push(`  Created: ${new Date(m.created_at).toISOString()}`);
  lines.push(`  Updated: ${new Date(m.updated_at).toISOString()}`);
  lines.push("");
  return lines.join("\n");
}

/** Format: JSON mission detail. */
export function formatMissionShowJson(result: MissionShowResult): string {
  return JSON.stringify(result.mission, null, 2) + "\n";
}

/** Entry point for `openclaw octo mission show`. Returns exit code. */
export function runMissionShow(
  registry: RegistryService,
  opts: MissionShowOptions,
  out: WritableOutput = defaultOut,
): number {
  const result = gatherMissionShow(registry, opts);
  if (result === null) {
    out.write(`Mission not found: ${opts.missionId}\n`);
    return 1;
  }
  const output = opts.json ? formatMissionShowJson(result) : formatMissionShow(result);
  out.write(output);
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════
// list
// ══════════════════════════════════════════════════════════════════════════

export interface MissionListOptions extends MissionJsonOption {
  status?: string;
  owner?: string;
  limit?: number;
}

export interface MissionListResult {
  missions: readonly MissionRecord[];
}

/** Gather: list missions with optional filters. */
export function gatherMissionList(
  registry: RegistryService,
  opts: MissionListOptions = {},
): MissionListResult {
  const missions = registry.listMissions({
    status: opts.status,
    owner: opts.owner,
    limit: opts.limit,
  });
  return { missions };
}

/** Format: human-readable mission list. */
export function formatMissionList(result: MissionListResult): string {
  const lines: string[] = [];
  if (result.missions.length === 0) {
    lines.push("No missions found.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`Missions (${result.missions.length}):`);
  for (const m of result.missions) {
    lines.push(`  ${m.mission_id}  ${m.status.padEnd(10)}  ${m.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Format: JSON mission list. */
export function formatMissionListJson(result: MissionListResult): string {
  return JSON.stringify(result.missions, null, 2) + "\n";
}

/** Entry point for `openclaw octo mission list`. Returns exit code. */
export function runMissionList(
  registry: RegistryService,
  opts: MissionListOptions = {},
  out: WritableOutput = defaultOut,
): number {
  const result = gatherMissionList(registry, opts);
  const output = opts.json ? formatMissionListJson(result) : formatMissionList(result);
  out.write(output);
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════
// pause
// ══════════════════════════════════════════════════════════════════════════

export interface MissionPauseOptions extends MissionJsonOption {
  missionId: string;
  idempotencyKey: string;
}

export interface MissionPauseResult {
  mission_id: string;
  status: "paused";
}

/** Gather: invoke gateway handler to pause a mission. */
export async function gatherMissionPause(
  handlers: OctoGatewayHandlers,
  opts: MissionPauseOptions,
): Promise<MissionPauseResult> {
  const response: MissionPauseResponse = await handlers.missionPause({
    mission_id: opts.missionId,
    idempotency_key: opts.idempotencyKey,
  });
  return { mission_id: response.mission_id, status: response.status };
}

/** Format: human-readable pause result. */
export function formatMissionPause(result: MissionPauseResult): string {
  return `Mission ${result.mission_id} paused.\n`;
}

/** Format: JSON pause result. */
export function formatMissionPauseJson(result: MissionPauseResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

/** Entry point for `openclaw octo mission pause`. Returns exit code. */
export async function runMissionPause(
  handlers: OctoGatewayHandlers,
  opts: MissionPauseOptions,
  out: WritableOutput = defaultOut,
): Promise<number> {
  const result = await gatherMissionPause(handlers, opts);
  const output = opts.json ? formatMissionPauseJson(result) : formatMissionPause(result);
  out.write(output);
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════
// resume
// ══════════════════════════════════════════════════════════════════════════

export interface MissionResumeOptions extends MissionJsonOption {
  missionId: string;
  idempotencyKey: string;
}

export interface MissionResumeResult {
  mission_id: string;
  status: "active";
}

/** Gather: invoke gateway handler to resume a mission. */
export async function gatherMissionResume(
  handlers: OctoGatewayHandlers,
  opts: MissionResumeOptions,
): Promise<MissionResumeResult> {
  const response: MissionResumeResponse = await handlers.missionResume({
    mission_id: opts.missionId,
    idempotency_key: opts.idempotencyKey,
  });
  return { mission_id: response.mission_id, status: response.status };
}

/** Format: human-readable resume result. */
export function formatMissionResume(result: MissionResumeResult): string {
  return `Mission ${result.mission_id} resumed.\n`;
}

/** Format: JSON resume result. */
export function formatMissionResumeJson(result: MissionResumeResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

/** Entry point for `openclaw octo mission resume`. Returns exit code. */
export async function runMissionResume(
  handlers: OctoGatewayHandlers,
  opts: MissionResumeOptions,
  out: WritableOutput = defaultOut,
): Promise<number> {
  const result = await gatherMissionResume(handlers, opts);
  const output = opts.json ? formatMissionResumeJson(result) : formatMissionResume(result);
  out.write(output);
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════
// abort
// ══════════════════════════════════════════════════════════════════════════

export interface MissionAbortOptions extends MissionJsonOption {
  missionId: string;
  reason: string;
  idempotencyKey: string;
}

export interface MissionAbortResult {
  mission_id: string;
  status: "aborted";
  arms_terminated: number;
}

/** Gather: invoke gateway handler to abort a mission. */
export async function gatherMissionAbort(
  handlers: OctoGatewayHandlers,
  opts: MissionAbortOptions,
): Promise<MissionAbortResult> {
  const response: MissionAbortResponse = await handlers.missionAbort({
    mission_id: opts.missionId,
    reason: opts.reason,
    idempotency_key: opts.idempotencyKey,
  });
  return {
    mission_id: response.mission_id,
    status: response.status,
    arms_terminated: response.arms_terminated,
  };
}

/** Format: human-readable abort result. */
export function formatMissionAbort(result: MissionAbortResult): string {
  const lines: string[] = [];
  lines.push(`Mission ${result.mission_id} aborted.`);
  lines.push(`Arms terminated: ${result.arms_terminated}`);
  lines.push("");
  return lines.join("\n");
}

/** Format: JSON abort result. */
export function formatMissionAbortJson(result: MissionAbortResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

/** Entry point for `openclaw octo mission abort`. Returns exit code. */
export async function runMissionAbort(
  handlers: OctoGatewayHandlers,
  opts: MissionAbortOptions,
  out: WritableOutput = defaultOut,
): Promise<number> {
  const result = await gatherMissionAbort(handlers, opts);
  const output = opts.json ? formatMissionAbortJson(result) : formatMissionAbort(result);
  out.write(output);
  return 0;
}
