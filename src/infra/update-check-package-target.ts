import { normalizeNullableString as toOptionalTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import { cancelUnreadResponseBody } from "./http-body.js";
import { UPDATE_NETWORK_TIMEOUT_MS } from "./update-network-budget.js";

type NpmPackageTargetStatus = {
  version: string | null;
  nodeEngine: string | null;
  schemaVersions?: OpenClawSchemaVersions;
  error?: string;
};

export type NpmMetadataCommandRunner = (
  argv: string[],
  options: {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
  },
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}>;

function parseNpmPackageTargetMetadata(
  raw: string,
  packageName: string,
): {
  version: string | null;
  nodeEngine: string | null;
  schemaVersions?: OpenClawSchemaVersions;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim()) as unknown;
  } catch (err) {
    throw new Error(`npm view returned invalid JSON: ${String(err)}`, { cause: err });
  }
  // npm 12 wraps `npm view --json` results in a singleton array.
  const entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { version: null, nodeEngine: null };
  }
  const rec = entry as Record<string, unknown>;
  const engines = rec.engines && typeof rec.engines === "object" ? rec.engines : null;
  const nodeEngine =
    toOptionalTrimmedString(rec["engines.node"]) ??
    (engines ? toOptionalTrimmedString((engines as Record<string, unknown>).node) : null);
  const schemaVersions = parsePackageOpenClawSchemaVersions({
    name: packageName,
    version: rec.version,
    openclaw: Object.hasOwn(rec, "openclaw.schemaVersions")
      ? { schemaVersions: rec["openclaw.schemaVersions"] }
      : rec.openclaw,
  });
  return {
    version: toOptionalTrimmedString(rec.version),
    nodeEngine,
    ...(schemaVersions ? { schemaVersions } : {}),
  };
}

function formatNpmViewError(res: { stdout: string; stderr: string }): string {
  const raw = (res.stderr.trim() || res.stdout.trim()).split("\n").slice(-3).join("\n");
  return raw ? `npm view failed: ${raw}` : "npm view failed";
}

function packageTargetSpec(params: { target: string; spec?: string }): string {
  const spec = params.spec?.trim();
  return spec || `openclaw@${params.target.trim() || "latest"}`;
}

const PUBLIC_NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const PUBLIC_NPM_PACKAGE_NAME = "openclaw";

class NpmRegistryHttpError extends Error {}

/** Reads one registry document, retaining the deadline until its body is consumed. */
export async function fetchRegistryPackageDocument<T = unknown>(params: {
  target: string;
  registryUrl?: string;
  packageName?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  label?: string;
  operation?: string;
  bodyTimeoutMs?: number;
}): Promise<T> {
  const registry = params.registryUrl ?? PUBLIC_NPM_REGISTRY_URL;
  const packageName = params.packageName ?? PUBLIC_NPM_PACKAGE_NAME;
  const url = new URL(
    `${encodeURIComponent(packageName)}/${encodeURIComponent(params.target)}`,
    registry.endsWith("/") ? registry : `${registry}/`,
  ).toString();
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: Math.max(1, params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS),
    signal: params.signal,
    operation: params.operation ?? "npm-registry-update-check",
    url,
  });
  let res: Response | undefined;
  try {
    res = await fetch(url, { signal });
    if (!res.ok) {
      throw new NpmRegistryHttpError(`HTTP ${res.status}`);
    }
    return await readProviderJsonResponse<T>(
      res,
      params.label ?? "npm package target status",
      params.bodyTimeoutMs === undefined
        ? undefined
        : { signal, chunkTimeoutMs: params.bodyTimeoutMs },
    );
  } finally {
    await cancelUnreadResponseBody(res);
    cleanup();
  }
}

export async function fetchNpmPackageTargetStatus(params: {
  target: string;
  timeoutMs?: number;
  spec?: string;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
  registryUrl?: string;
  packageName?: string;
  /** Aborts registry reads; command runners own their own cancellation. */
  signal?: AbortSignal;
}): Promise<NpmPackageTargetStatus> {
  const timeoutMs = params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS;
  try {
    if (!params.command && !params.runCommand) {
      const json = await fetchRegistryPackageDocument<{
        version?: unknown;
        engines?: { node?: unknown };
        openclaw?: { schemaVersions?: unknown };
      }>(params);
      const schemaVersions = parsePackageOpenClawSchemaVersions({
        ...json,
        name: params.packageName ?? PUBLIC_NPM_PACKAGE_NAME,
      });
      return {
        version: toOptionalTrimmedString(json.version),
        nodeEngine: toOptionalTrimmedString(json.engines?.node),
        ...(schemaVersions ? { schemaVersions } : {}),
      };
    }
    const runCommand = params.runCommand ?? runCommandWithTimeout;
    const spec = packageTargetSpec(params);
    const res = await runCommand(
      [
        params.command ?? "npm",
        "view",
        spec,
        "version",
        "engines.node",
        "openclaw.schemaVersions",
        "--json",
        "--global",
      ],
      {
        timeoutMs: Math.max(1, timeoutMs),
        cwd: params.cwd,
        env: params.env,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (res.code !== 0) {
      return {
        version: null,
        nodeEngine: null,
        error: formatNpmViewError(res),
      };
    }
    return {
      ...parseNpmPackageTargetMetadata(
        res.stdout,
        spec === "openclaw" || /^openclaw@[^:/]+$/.test(spec) ? "openclaw" : "",
      ),
    };
  } catch (err) {
    return {
      version: null,
      nodeEngine: null,
      error: err instanceof NpmRegistryHttpError ? err.message : String(err),
    };
  }
}
