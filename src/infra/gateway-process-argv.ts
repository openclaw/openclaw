// Parses gateway process command lines for process discovery.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isBunRuntime, isNodeRuntime } from "../daemon/runtime-binary.js";
import { isLegacyPluginSourceCaptureName } from "../plugins/plugin-source-capture-path.js";
import { getRootOptionAwareCommandPath } from "./cli-root-options.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";

function normalizeProcArg(arg: string): string {
  return normalizeLowercaseStringOrEmpty(arg.replaceAll("\\", "/"));
}

const ENTRY_CANDIDATES = [
  "openclaw.mjs",
  "dist/index.js",
  "dist/entry.js",
  "scripts/run-node.mjs",
  "src/entry.ts",
  "src/index.ts",
] as const;

export type OpenClawArgvClassification =
  | { kind: "openclaw"; entryIndex?: number }
  | { kind: "other" }
  | { kind: "unclassified"; reason: string };

type ClassificationOptions = {
  command?: string;
  serviceMarker?: string;
  owner?: GatewayOwnerLeaseIdentity;
  port?: number;
  cwd?: string;
  pid?: number;
  additionalEntrypoints?: readonly string[];
};

function readProcessWorkingDirectory(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    if (process.platform === "linux") {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    }
    if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F0n"], {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 64 * 1024,
        env: resolveDiagnosticProcessEnv(),
      });
      if (result.error || result.status !== 0) {
        return undefined;
      }
      const fields = result.stdout.split("\0").map((field) => field.replace(/^\n/, ""));
      const names = fields.filter((field) => field.startsWith("n"));
      if (fields[0] === `p${pid}` && names.length === 1) {
        return names[0]!.slice(1);
      }
    }
  } catch {
    // An inaccessible cwd never licenses resolving against this inspector's cwd.
  }
  return undefined;
}

const RUNTIME_VALUE_OPTIONS = new Set([
  "-r",
  "-C",
  "--env-file",
  "--env-file-if-exists",
  "--tsconfig",
  "--cwd",
  "--preload",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "--icu-data-dir",
  "--openssl-config",
  "--title",
  "--disable-warning",
  "--disable-proto",
  "--cpu-prof-name",
  "--max-old-space-size",
]);
const RUNTIME_BOOLEAN_OPTIONS = new Set([
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--expose-gc",
  "--jitless",
  "--no-opt",
  "--experimental-strip-types",
  "--bun",
]);

function runtimeScript(args: string[]): number | OpenClawArgvClassification {
  const executable = args[0] ?? "";
  const basename = normalizeProcArg(executable).split("/").at(-1);
  const bun = isBunRuntime(executable);
  const tsx = basename === "tsx" || basename === "tsx.cmd";
  let consumedSubcommand = false;
  if (!isNodeRuntime(executable) && !bun && !tsx) {
    return { kind: "other" };
  }
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      return args[index + 1] ? index + 1 : { kind: "other" };
    }
    if (
      arg === "-e" ||
      arg === "--eval" ||
      arg === "-p" ||
      arg === "--print" ||
      arg === "--run" ||
      /^(?:--eval|--print|--run)=/.test(arg)
    ) {
      return { kind: "other" };
    }
    if (RUNTIME_VALUE_OPTIONS.has(arg)) {
      index++;
    } else if (arg.startsWith("-")) {
      // A negated spelling proves a boolean; its absence never proves a value option.
      const negated = `--no-${arg.replace(/^--(?:no-)?/, "")}`;
      if (
        RUNTIME_BOOLEAN_OPTIONS.has(arg) ||
        /^--[^=]+=/.test(arg) ||
        (process.allowedNodeEnvironmentFlags.has(arg) &&
          process.allowedNodeEnvironmentFlags.has(negated))
      ) {
        continue;
      }
      return { kind: "unclassified", reason: `unsupported runtime option ${arg}` };
    } else if (!consumedSubcommand && ((bun && arg === "run") || (tsx && arg === "watch"))) {
      consumedSubcommand = true;
      continue;
    } else {
      return index;
    }
  }
  return { kind: "other" };
}

/** Generic script names identify OpenClaw only inside a verified package root. */
function classifyEntrypoint(
  args: string[],
  opts: ClassificationOptions = {},
): OpenClawArgvClassification {
  const exe = normalizeProcArg(args[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
  if (exe.endsWith("/openclaw") || exe === "openclaw") {
    return { kind: "openclaw", entryIndex: 0 };
  }
  const entryIndex = /(?:^|\/)openclaw\.mjs$/.test(exe) ? 0 : runtimeScript(args);
  if (typeof entryIndex !== "number") {
    return entryIndex;
  }
  const script = args[entryIndex]!;
  const normalized = normalizeProcArg(script);
  if (/(?:^|\/)openclaw\.mjs$/.test(normalized)) {
    return { kind: "openclaw", entryIndex };
  }
  const entrypoints = [...ENTRY_CANDIDATES, ...(opts.additionalEntrypoints ?? [])];
  let scriptPath = script;
  if (!path.isAbsolute(script)) {
    const cwd =
      opts.cwd ?? (opts.pid === undefined ? undefined : readProcessWorkingDirectory(opts.pid));
    if (!cwd || !path.isAbsolute(cwd)) {
      return { kind: "unclassified", reason: `working directory is unavailable for ${script}` };
    }
    scriptPath = path.resolve(cwd, script);
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(scriptPath);
  } catch {
    return { kind: "unclassified", reason: `could not resolve script ${script}` };
  }
  const resolvedNormalized = normalizeProcArg(resolved);
  const entry = entrypoints.find((candidate) => resolvedNormalized.endsWith(`/${candidate}`));
  if (!entry) {
    return { kind: "other" };
  }
  const root = resolved.slice(0, -entry.length);
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return { kind: "unclassified", reason: `could not read package identity for ${script}` };
  }
  return isRecord(manifest) && manifest.name === "openclaw"
    ? { kind: "openclaw", entryIndex }
    : { kind: "other" };
}

export function parseProcCmdline(raw: string): string[] {
  return normalizeStringEntries(raw.split("\0"));
}

/** One classification for process owners, command consumers, and diagnostics. */
export function classifyOpenClawArgv(
  args: string[],
  opts: ClassificationOptions = {},
): OpenClawArgvClassification {
  const { command, owner, pid, port } = opts;
  if (
    command === "gateway" &&
    owner?.pid === pid &&
    owner?.state === "live" &&
    (port === undefined || owner.port === port)
  ) {
    return { kind: "openclaw" };
  }
  const executable =
    normalizeProcArg(args[0] ?? "")
      .split("/")
      .at(-1)
      ?.replace(/\.(exe|cmd|bat)$/, "") ?? "";
  if (/^openclaw-[a-z0-9-]+$/.test(executable)) {
    return !command || executable === `openclaw-${command}`
      ? { kind: "openclaw" }
      : { kind: "other" };
  }
  const identity = classifyEntrypoint(args, opts);
  if (command) {
    return identity.kind === "openclaw" &&
      normalizeProcArg(
        getRootOptionAwareCommandPath(["node", ...args.slice(identity.entryIndex)], 1)[0] ?? "",
      ) !== command
      ? { kind: "other" }
      : identity;
  }
  if (
    identity.kind === "openclaw" ||
    args.some((arg) => arg.replaceAll("\\", "/").split("/").some(isLegacyPluginSourceCaptureName))
  ) {
    return identity.kind === "openclaw" ? identity : { kind: "openclaw" };
  }
  let marker = opts.serviceMarker;
  if (
    pid !== undefined &&
    process.platform === "linux" &&
    (isNodeRuntime(executable) || isBunRuntime(executable) || executable === "tsx")
  ) {
    try {
      marker = fs
        .readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .find((entry) => entry.startsWith("OPENCLAW_SERVICE_MARKER="))
        ?.slice("OPENCLAW_SERVICE_MARKER=".length);
    } catch (error) {
      return {
        kind: "unclassified",
        reason: `process identity inspection failed (${extractErrorCode(error) ?? "unavailable"})`,
      };
    }
  }
  return marker === "openclaw" ? { kind: "openclaw" } : identity;
}
