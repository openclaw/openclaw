/** Live launchd diagnostics and narrowly scoped Doctor repair for auxiliary jobs. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { hasTopLevelShellControlOperator, splitShellArgs } from "../utils/shell-argv.js";
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

function lifecycleAction(args: string[]): GatewayAction | undefined {
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
  if (["node", "bun"].includes(path.basename(words[0] ?? ""))) {
    words = words.slice(1);
    if (path.basename(words[0] ?? "") !== "openclaw.mjs") {
      return undefined;
    }
  }
  if (!["openclaw", "openclaw.mjs"].includes(path.basename(words[0] ?? ""))) {
    return undefined;
  }
  words = words.slice(1);
  if (words[0] === "--profile" && words[1]) {
    words = words.slice(2);
  }
  const action = words[1];
  return words[0] === "gateway" && (action === "restart" || action === "start" || action === "stop")
    ? action
    : undefined;
}

function scriptActions(script: string): GatewayAction[] {
  // A diagnostic is not a shell interpreter. Never mistake heredoc/documentation
  // contents or multiline quoted strings for executable command positions.
  if (script.includes("<<") || script.includes("\\\n") || /''|""/.test(script)) {
    return [];
  }
  const lines = script.split(/\r?\n/);
  const parsed = lines.map((line) => splitShellArgs(line));
  if (parsed.some((words) => words === null)) {
    return [];
  }
  const actions = new Set<GatewayAction>();
  const variables = new Map<string, string>();
  for (const [i, line] of lines.entries()) {
    const words = parsed[i] ?? [];
    if (!words.length) {
      continue;
    }
    if (hasTopLevelShellControlOperator(line) || /`|\$\(/.test(line)) {
      break;
    }
    const assignmentWords = words[0] === "export" ? words.slice(1) : words;
    const assignment =
      assignmentWords.length === 1 && assignmentWords[0]?.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assignment) {
      const [, name, value] = assignment;
      if (!name || value === undefined || /[`$]/.test(value)) {
        break;
      }
      // Shell-special parameters do not obey ordinary assignment semantics.
      // Resolve only literal OpenClaw helper variables.
      variables.delete(name);
      if (/^(?:openclaw_|OPENCLAW_)/.test(name) && /^[A-Za-z0-9_./-]+$/.test(value)) {
        variables.set(name, value);
      }
      continue;
    }
    const commandIndex = words[0] === "exec" ? 1 : 0;
    const variable = words[commandIndex]?.match(
      /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/,
    );
    if (variable) {
      // Only an explicit literal assignment proves an indirect CLI command.
      const expandsCommand =
        /^\s*(?:exec\s+)?"\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})"\s/.test(line);
      const name = variable[1] ?? variable[2];
      words[commandIndex] = expandsCommand && name ? (variables.get(name) ?? "") : "";
    }
    const action = lifecycleAction(words[0] === "exec" ? words.slice(1) : words);
    if (action) {
      actions.add(action);
      continue;
    }
    // Stop at unknown execution/control flow rather than treating unreachable
    // function/conditional bodies or a reassigned command variable as evidence.
    const safeSet =
      words[0] === "set" &&
      words.length > 1 &&
      (words.slice(1).every((word) => /^[+-][eux]+$/.test(word)) ||
        (words.length === 3 && words[1] === "-o" && words[2] === "pipefail"));
    if (
      !safeSet &&
      !(
        words[0] === "exec" &&
        !line.includes("$") &&
        words.slice(1).every((word) => /^\d*>/.test(word))
      )
    ) {
      break;
    }
  }
  return [...actions].toSorted();
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
  const command = args.length ? [program, ...args.slice(1)] : [program];
  const direct = lifecycleAction(command);
  if (direct) {
    actions = [direct];
  } else if (SHELLS.has(path.basename(program))) {
    const script = await readShellScript(command.slice(1));
    actions = script ? scriptActions(script) : [];
    diagnostic = actions.length
      ? undefined
      : "Shell command could not be verified; left unchanged.";
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
