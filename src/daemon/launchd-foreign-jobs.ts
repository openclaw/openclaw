/** Live launchd diagnostics and narrowly scoped Doctor repair for auxiliary jobs. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveGatewayLaunchAgentLabel, resolveNodeLaunchAgentLabel } from "./constants.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";

type GatewayAction = "restart" | "start" | "stop";
export type ForeignLaunchdJob = {
  label: string;
  program: string;
  keepAlive: boolean;
  gatewayActions: GatewayAction[];
  safeToRemove: boolean;
  plistPath?: string;
  diagnostic?: string;
};

const MAX_JOBS = 64;
const INSPECTION_TIMEOUT_MS = 2_000;
const MAX_FILE_BYTES = 64 * 1024;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_EXECUTION_ENV_NAMES = new Set([
  "SHELLOPTS",
  "BASHOPTS",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "POSIXLY_CORRECT",
  "IFS",
  "CDPATH",
  "PS4",
  "BASH_XTRACEFD",
]);

function hasShellExecutionEnvironment(environment: string): boolean {
  for (const [, name] of environment.matchAll(/^\t\t(.+?) => /gm)) {
    if (name && (SHELL_EXECUTION_ENV_NAMES.has(name) || name.startsWith("BASH_"))) {
      return true;
    }
  }
  return false;
}

function isCandidate(label: string, env: NodeJS.ProcessEnv): boolean {
  return (
    /^ai\.openclaw\.[A-Za-z0-9._-]+$/.test(label) &&
    !new Set([
      resolveGatewayLaunchAgentLabel(),
      resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE),
      resolveLaunchAgentLabel(env),
      resolveNodeLaunchAgentLabel(),
    ]).has(label)
  );
}

function lifecycleInvocation(
  args: string[],
): { action: GatewayAction; program: string } | undefined {
  if (args.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg))) {
    return undefined;
  }
  let words = args;
  if (path.basename(words[0] ?? "") === "env") {
    words = words.slice(1);
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
      words = words.slice(1);
    }
  }
  const program = words[0] ?? "";
  if (!path.isAbsolute(program)) {
    return undefined;
  }
  if (["node", "bun"].includes(path.basename(words[0] ?? ""))) {
    words = words.slice(1);
    if (path.basename(words[0] ?? "") !== "openclaw.mjs") {
      return undefined;
    }
  }
  if (
    !path.isAbsolute(words[0] ?? "") ||
    !["openclaw", "openclaw.mjs"].includes(path.basename(words[0] ?? ""))
  ) {
    return undefined;
  }
  words = words.slice(1);
  if (words[0] === "--profile" && words[1]) {
    words = words.slice(2);
  }
  const action = words[1];
  return words[0] === "gateway" && (action === "restart" || action === "start" || action === "stop")
    ? { action, program }
    : undefined;
}

const SCRIPT_HELPER_NAME = /(?:openclaw_|OPENCLAW_)[A-Za-z0-9_]*/;
const SCRIPT_LITERAL_EXEC = String.raw`/(?:[A-Za-z0-9_.-]+/)*openclaw(?:\.mjs)?`;
const SCRIPT_HELPER_REF = String.raw`\$(?:${SCRIPT_HELPER_NAME.source}|\{${SCRIPT_HELPER_NAME.source}\})`;
// JavaScript's $ can stop before a final Unicode separator; require the raw end.
const SCRIPT_LINE_END = String.raw`$(?![\s\S])`;
const SCRIPT_EXECUTABLE = new RegExp(`^${SCRIPT_LITERAL_EXEC}${SCRIPT_LINE_END}`);
const SCRIPT_ASSIGNMENT = new RegExp(
  String.raw`^[ \t]*(?:export[ \t]+)?(${SCRIPT_HELPER_NAME.source})=([A-Za-z0-9_./-]+)[ \t]*${SCRIPT_LINE_END}`,
);
const SCRIPT_INVOCATION = new RegExp(
  String.raw`^[ \t]*(?:exec[ \t]+)?(${SCRIPT_LITERAL_EXEC}|${SCRIPT_HELPER_REF}|"${SCRIPT_HELPER_REF}")[ \t]+gateway[ \t]+(restart|start|stop)((?:[ \t]+[A-Za-z0-9_.=/:-]+)*)[ \t]*${SCRIPT_LINE_END}`,
);

// Verify literal, straight-line prefixes ending in a Gateway lifecycle call to
// an absolute OpenClaw path; inspectJob also excludes shell-altering job environments.
// Other syntax is report-only. This checks metadata, not binary executability,
// interpreter availability or quarantine, and never dequotes or expands shell words.
function scriptActions(script: string): GatewayAction[] {
  if (script.includes("\r") || script.includes("<<") || script.includes("\\\n")) {
    return [];
  }
  const variables = new Map<string, string>();
  for (const line of script.split("\n")) {
    if (/^[ \t]*(?:#.*)?$(?![\s\S])/.test(line)) {
      continue;
    }
    if (
      /^[ \t]*set(?:[ \t]+[+-][eux])+[ \t]*$(?![\s\S])/.test(line) ||
      /^[ \t]*set[ \t]+-o[ \t]+pipefail[ \t]*$(?![\s\S])/.test(line)
    ) {
      continue;
    }
    const assignment = SCRIPT_ASSIGNMENT.exec(line);
    if (assignment?.[1] && assignment[2]) {
      variables.set(assignment[1], assignment[2]);
      continue;
    }
    const invocation = SCRIPT_INVOCATION.exec(line);
    const executable = invocation?.[1];
    const action = invocation?.[2];
    if (!executable || (action !== "restart" && action !== "start" && action !== "stop")) {
      return [];
    }
    if (!SCRIPT_EXECUTABLE.test(executable)) {
      const name = executable.match(SCRIPT_HELPER_NAME)?.[0];
      const resolved = name && variables.get(name);
      if (!resolved || !SCRIPT_EXECUTABLE.test(resolved)) {
        return [];
      }
    }
    if (/(?:^|[ \t])(?:-h|--help|-V|--version)(?:[ \t]|$)/.test(invocation?.[3] ?? "")) {
      return [];
    }
    return [action];
  }
  return [];
}

async function readShellScript(args: string[]): Promise<string | undefined> {
  for (const [index, arg] of args.entries()) {
    if (arg === "--") {
      return await readOwnedText(args[index + 1] ?? "");
    }
    if (!arg.startsWith("-")) {
      return await readOwnedText(arg);
    }
    // Recognize only executing options, and only before the command file.
    // Everything after that file is positional data, even a literal '-c'.
    if (/^-[elux]*c[elux]*$/.test(arg)) {
      return args[index + 1];
    }
    if (!/^-[elux]+$/.test(arg)) {
      return undefined;
    }
  }
  return undefined;
}

function hasShellShebang(script: string): boolean {
  const firstLine = script.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) {
    return false;
  }
  const [interpreter = "", ...options] = firstLine.slice(2).trim().split(/\s+/);
  if (interpreter === "/usr/bin/env") {
    return options.length === 1 && SHELLS.has(options[0] ?? "");
  }
  // Preserve the same executing-option boundary as explicit shell launches.
  return (
    path.isAbsolute(interpreter) &&
    SHELLS.has(path.basename(interpreter)) &&
    (options.length === 0 || (options.length === 1 && /^-[elux]+$/.test(options[0] ?? "")))
  );
}

async function readOwnedText(filePath: string): Promise<string | undefined> {
  if (!path.isAbsolute(filePath)) {
    return undefined;
  }
  const file = await fs
    .open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => null);
  if (!file) {
    return undefined;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.uid !== process.getuid?.()) {
      return undefined;
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead <= MAX_FILE_BYTES ? buffer.subarray(0, bytesRead).toString("utf8") : undefined;
  } finally {
    await file.close();
  }
}

async function inspectJob(
  label: string,
  env: NodeJS.ProcessEnv,
): Promise<ForeignLaunchdJob | null> {
  if (!isCandidate(label, env)) {
    return null;
  }
  const target = `${resolveLaunchAgentGuiDomain()}/${label}`;
  const result = await execLaunchctl(["print", target], INSPECTION_TIMEOUT_MS);
  if (isLaunchctlNotLoaded(result)) {
    return null;
  }
  if (result.code !== 0) {
    throw new Error(`Cannot inspect launchd job ${label}: ${formatLaunchctlResultDetail(result)}`);
  }
  const output = result.stdout;
  if (!output.startsWith(`${target} = {\n`)) {
    throw new Error(`Cannot parse launchd job ${label}`);
  }
  const field = (name: string) => output.match(new RegExp(`^\\t${name} = (.+)$`, "m"))?.[1];
  const program = field("program") ?? "unknown";
  const rawPath = field("path");
  const plistPath = rawPath?.startsWith("/") ? rawPath : undefined;
  const args = (output.match(/^\targuments = \{\n([\s\S]*?)^\t\}/m)?.[1] ?? "")
    .split("\n")
    .filter((line) => line.startsWith("\t\t"))
    .map((line) => line.slice(2));
  const environment = output.match(/^\tenvironment = \{\n([\s\S]*?)^\t\}/m)?.[1] ?? "";
  // launchd also injects the `inherited environment` and `default environment`
  // blocks into the process; a shell reads BASH_ENV/SHELLOPTS from any of them.
  const environmentBlocks = [
    ...output.matchAll(/^\t(?:inherited |default )?environment = \{\n([\s\S]*?)^\t\}/gm),
  ]
    .map((match) => match[1] ?? "")
    .join("\n");
  const plist = plistPath ? await readOwnedText(plistPath) : undefined;
  const hasServiceMarker =
    /^\t\tOPENCLAW_SERVICE_MARKER => openclaw$/m.test(environment) &&
    /^\t\tOPENCLAW_SERVICE_KIND => (gateway|node)$/m.test(environment);
  const generatedWrapper = args.some((arg) => arg.endsWith(`/service-env/${label}-env-wrapper.sh`));
  if (
    hasServiceMarker ||
    generatedWrapper ||
    /<key>Comment<\/key>\s*<string>OpenClaw (Gateway|Node)\b/.test(plist ?? "")
  ) {
    return null;
  }
  let actions: GatewayAction[] = [];
  let diagnostic: string | undefined;
  const shellEnvironmentDiagnostic = hasShellExecutionEnvironment(environmentBlocks)
    ? "Shell environment alters execution; left unchanged."
    : undefined;
  const command = args.length ? [program, ...args.slice(1)] : [program];
  const direct = path.isAbsolute(program) ? lifecycleInvocation(command) : undefined;
  const programName = path.basename(program);
  const isShell = SHELLS.has(programName);
  // A CLI basename can also name an owned shell launcher. Check that header
  // before accepting direct argv when the job carries shell-altering environment.
  const programScript =
    !isShell &&
    (shellEnvironmentDiagnostic ||
      !["openclaw", "openclaw.mjs", "node", "bun", "env"].includes(programName))
      ? await readOwnedText(program)
      : undefined;
  let isShellScript = programScript !== undefined && hasShellShebang(programScript);
  // env executes its selected program directly, including an owned shell launcher.
  if (shellEnvironmentDiagnostic && direct && direct.program !== program) {
    const selectedScript = await readOwnedText(direct.program);
    isShellScript ||= selectedScript !== undefined && hasShellShebang(selectedScript);
  }
  if (shellEnvironmentDiagnostic && (isShell || isShellScript)) {
    diagnostic = shellEnvironmentDiagnostic;
  } else if (direct) {
    actions = [direct.action];
  } else if (isShell) {
    const script = await readShellScript(command.slice(1));
    actions = script ? scriptActions(script) : [];
    diagnostic = actions.length
      ? undefined
      : "Shell command could not be verified; left unchanged.";
  } else if (isShellScript && programScript !== undefined) {
    actions = scriptActions(programScript);
  }
  return {
    label,
    program: sanitizeForLog(program),
    keepAlive: /(?:^|\s|\|)keepalive(?:\s|\||$)/.test(field("properties") ?? ""),
    gatewayActions: actions,
    safeToRemove: actions.length > 0 && (field("type") === "Submitted" || Boolean(plist)),
    ...(plistPath ? { plistPath } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export async function findForeignLaunchdJobs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ForeignLaunchdJob[]> {
  if (process.platform !== "darwin") {
    return [];
  }
  const result = await execLaunchctl(["list"], INSPECTION_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new Error(`Cannot list launchd jobs: ${formatLaunchctlResultDetail(result)}`);
  }
  const labels = [
    ...new Set(
      result.stdout.split(/\r?\n/).flatMap((line) => {
        const label = line.trim().match(/^(?:-|\d+)\s+-?\d+\s+(\S+)$/)?.[1];
        return label && isCandidate(label, env) ? [label] : [];
      }),
    ),
  ].toSorted();
  if (labels.length > MAX_JOBS) {
    throw new Error(
      `Too many OpenClaw launchd jobs to inspect safely (${labels.length}; limit ${MAX_JOBS}).`,
    );
  }
  const jobs: ForeignLaunchdJob[] = [];
  const deadline = Date.now() + 10_000;
  for (const label of labels) {
    if (Date.now() >= deadline) {
      throw new Error("OpenClaw launchd job inspection exceeded its 10-second budget.");
    }
    const job = await inspectJob(label, env);
    if (job) {
      jobs.push(job);
    }
  }
  return jobs;
}

export function formatForeignLaunchdJobs(jobs: ForeignLaunchdJob[]): string {
  return jobs
    .map((job) =>
      [
        `${job.label}: program=${job.program}, keepalive=${job.keepAlive}, Gateway lifecycle=${job.gatewayActions.join("|") || "not verified"}`,
        job.safeToRemove
          ? "  Removable with openclaw doctor --fix."
          : "  Report only; left unchanged.",
        ...(job.diagnostic ? [`  ${job.diagnostic}`] : []),
      ].join("\n"),
    )
    .join("\n");
}

export async function repairForeignLaunchdJob(
  job: ForeignLaunchdJob,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ removed: boolean; detail: string }> {
  if (process.platform !== "darwin" || !isCandidate(job.label, env)) {
    return { removed: false, detail: "Protected or unrelated launchd label; left unchanged." };
  }
  // Fresh native inspection, not a caller-supplied removal flag, owns authority.
  const current = await inspectJob(job.label, env);
  if (!current?.safeToRemove) {
    return {
      removed: false,
      detail: "Gateway lifecycle command no longer verified; left unchanged.",
    };
  }
  const target = `${resolveLaunchAgentGuiDomain()}/${current.label}`;
  if (current.plistPath) {
    // Keep operator files intact, but prevent a plist-backed job returning at login.
    const disabled = await execLaunchctl(["disable", target], INSPECTION_TIMEOUT_MS);
    if (disabled.code !== 0) {
      return {
        removed: false,
        detail: `Could not disable ${current.label}: ${formatLaunchctlResultDetail(disabled)}`,
      };
    }
    const refreshed = await inspectJob(current.label, env);
    if (
      !refreshed?.safeToRemove ||
      refreshed.program !== current.program ||
      refreshed.plistPath !== current.plistPath
    ) {
      return {
        removed: false,
        detail: `Disabled ${current.label}, but its definition changed before removal; inspect it manually.`,
      };
    }
  }
  const removed = await execLaunchctl(["bootout", target], INSPECTION_TIMEOUT_MS);
  if (removed.code !== 0 && !isLaunchctlNotLoaded(removed)) {
    return {
      removed: false,
      detail: `Could not remove ${current.label}: ${formatLaunchctlResultDetail(removed)}`,
    };
  }
  const probe = await execLaunchctl(["print", target], INSPECTION_TIMEOUT_MS);
  return isLaunchctlNotLoaded(probe)
    ? {
        removed: true,
        detail: `Removed stray launchd job ${current.label} (${current.program}; Gateway ${current.gatewayActions.join("/")}).${current.plistPath ? " Disabled at login; plist retained." : ""}`,
      }
    : {
        removed: false,
        detail: `Removal of ${current.label} could not be confirmed; inspect launchctl print ${target}.`,
      };
}
