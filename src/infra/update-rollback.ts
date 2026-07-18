/** One-shot package update rollback transaction shared by updater, service wrapper, and narration. */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export const UPDATE_ROLLBACK_MARKER_FILENAME = "update-rollback";
const UPDATE_ROLLBACK_MARKER_VERSION = "1";
const UPDATE_ROLLBACK_MARKER_MAX_BYTES = 8 * 1024;
const UPDATE_ROLLBACK_ERROR_MAX_LENGTH = 500;

export type UpdateRollbackTransaction = {
  state: "pending" | "rolled_back";
  newVersion: string;
  previousVersion: string;
  currentRoot: string;
  retainedRoot: string;
  gatewayPort: number;
  error?: string;
};

export function resolveUpdateRollbackMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), UPDATE_ROLLBACK_MARKER_FILENAME);
}

function normalizeMarkerValue(value: string, maxLength: number): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeRoot(value: string): string | null {
  const normalized = normalizeMarkerValue(value, 4096);
  if (!normalized || !path.isAbsolute(normalized) || path.parse(normalized).root === normalized) {
    return null;
  }
  return path.resolve(normalized);
}

export function parseUpdateRollbackMarker(raw: string): UpdateRollbackTransaction | null {
  if (Buffer.byteLength(raw, "utf8") > UPDATE_ROLLBACK_MARKER_MAX_BYTES) {
    return null;
  }
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return null;
    }
    const key = line.slice(0, separator);
    if (fields.has(key)) {
      return null;
    }
    fields.set(key, line.slice(separator + 1));
  }
  if (fields.get("version") !== UPDATE_ROLLBACK_MARKER_VERSION) {
    return null;
  }
  const state = fields.get("state");
  const newVersion = normalizeMarkerValue(fields.get("new_version") ?? "", 128);
  const previousVersion = normalizeMarkerValue(fields.get("previous_version") ?? "", 128);
  const currentRoot = normalizeRoot(fields.get("current_root") ?? "");
  const retainedRoot = normalizeRoot(fields.get("retained_root") ?? "");
  const gatewayPort = Number(fields.get("gateway_port"));
  const errorValue = fields.get("error");
  const error = errorValue
    ? normalizeMarkerValue(errorValue, UPDATE_ROLLBACK_ERROR_MAX_LENGTH)
    : null;
  if (
    (state !== "pending" && state !== "rolled_back") ||
    !newVersion ||
    !previousVersion ||
    !currentRoot ||
    !retainedRoot ||
    currentRoot === retainedRoot ||
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65_535 ||
    (state === "rolled_back" && !error)
  ) {
    return null;
  }
  return {
    state,
    newVersion,
    previousVersion,
    currentRoot,
    retainedRoot,
    gatewayPort,
    ...(error ? { error } : {}),
  };
}

export function serializeUpdateRollbackMarker(transaction: UpdateRollbackTransaction): string {
  const parsed = parseUpdateRollbackMarker(
    [
      `version=${UPDATE_ROLLBACK_MARKER_VERSION}`,
      `state=${transaction.state}`,
      `new_version=${transaction.newVersion}`,
      `previous_version=${transaction.previousVersion}`,
      `current_root=${transaction.currentRoot}`,
      `retained_root=${transaction.retainedRoot}`,
      `gateway_port=${transaction.gatewayPort}`,
      ...(transaction.error ? [`error=${transaction.error}`] : []),
      "",
    ].join("\n"),
  );
  if (!parsed) {
    throw new Error("Invalid update rollback transaction");
  }
  return [
    `version=${UPDATE_ROLLBACK_MARKER_VERSION}`,
    `state=${parsed.state}`,
    `new_version=${parsed.newVersion}`,
    `previous_version=${parsed.previousVersion}`,
    `current_root=${parsed.currentRoot}`,
    `retained_root=${parsed.retainedRoot}`,
    `gateway_port=${parsed.gatewayPort}`,
    ...(parsed.error ? [`error=${parsed.error}`] : []),
    "",
  ].join("\n");
}

export async function writeUpdateRollbackTransaction(params: {
  transaction: UpdateRollbackTransaction;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const markerPath = resolveUpdateRollbackMarkerPath(params.env);
  await fs.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, serializeUpdateRollbackMarker(params.transaction), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(temporaryPath, 0o600);
  await fs.rename(temporaryPath, markerPath);
  return markerPath;
}

export async function readUpdateRollbackTransaction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRollbackTransaction | null> {
  const markerPath = resolveUpdateRollbackMarkerPath(env);
  const stat = await fs.lstat(markerPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > UPDATE_ROLLBACK_MARKER_MAX_BYTES) {
    return null;
  }
  const raw = await fs.readFile(markerPath, "utf8").catch(() => null);
  return raw === null ? null : parseUpdateRollbackMarker(raw);
}

export function formatUpdateRollbackNarration(
  transaction: UpdateRollbackTransaction | null,
): string | null {
  if (transaction?.state !== "rolled_back" || !transaction.error) {
    return null;
  }
  return `The update to ${transaction.newVersion} broke and was rolled back to ${transaction.previousVersion}; the error was: ${transaction.error}; run \`openclaw update\` to retry.`;
}
