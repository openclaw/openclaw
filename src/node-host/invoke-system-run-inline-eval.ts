import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import {
  detectInterpreterInlineEvalArgv,
  type InterpreterInlineEvalHit,
} from "../infra/command-analysis/inline-eval.js";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";

type MaterializedInlineEvalCommand = {
  argv: string[];
  scriptPath: string;
};

type InlineEvalInterpreterSnapshot = {
  resolvedPath: string;
  resolvedRealPath: string;
};

const INLINE_EVAL_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INLINE_EVAL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const INLINE_EVAL_CACHE_MAX_FILES = 256;
const INLINE_EVAL_CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const INLINE_EVAL_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const MATERIALIZED_SCRIPT_PATTERN = /^[a-f0-9]{64}\.sh$/;
const MATERIALIZED_TEMP_PATTERN = /^\.[a-f0-9]{64}\.\d+\.[a-f0-9-]+\.tmp$/;
const INLINE_EVAL_ARGV_MARKER = "# openclaw-inline-eval-argv-v1:";
const inlineEvalCacheSweepTimers = new Map<string, NodeJS.Timeout>();

function resolveMaterializableInlineEvalCodeIndex(argv: string[], flag: string): number | null {
  if (argv.length !== 3) {
    return null;
  }
  return normalizeNullableString(argv[1]) === flag ? 2 : null;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function resolvePythonVenvLauncher(interpreter: InlineEvalInterpreterSnapshot): string | undefined {
  if (interpreter.resolvedPath === interpreter.resolvedRealPath) {
    return undefined;
  }
  const venvRoot = path.dirname(path.dirname(interpreter.resolvedPath));
  try {
    return fs.statSync(path.join(venvRoot, "pyvenv.cfg")).isFile()
      ? interpreter.resolvedPath
      : undefined;
  } catch {
    return undefined;
  }
}

function renderMaterializedInlineEvalScript(params: {
  normalizedExecutable: string;
  flag: string;
  code: string;
  originalArgv: string[];
  interpreter: InlineEvalInterpreterSnapshot;
  pythonVenvLauncher?: string;
}): string | null {
  const argvMarker = `${INLINE_EVAL_ARGV_MARKER}${Buffer.from(JSON.stringify(params.originalArgv)).toString("base64url")}`;
  if (/^(?:python|python\d+(?:\.\d+)*)$/.test(params.normalizedExecutable)) {
    const venvLines = params.pythonVenvLauncher
      ? [
          `__PYVENV_LAUNCHER__=${quotePosixShellArg(params.pythonVenvLauncher)}`,
          "export __PYVENV_LAUNCHER__",
        ]
      : [];
    return [
      "#!/bin/sh",
      argvMarker,
      "set -eu",
      ...venvLines,
      `exec ${quotePosixShellArg(params.interpreter.resolvedRealPath)} ${quotePosixShellArg(params.flag)} ${quotePosixShellArg(params.code)}`,
      "",
    ].join("\n");
  }
  if (params.normalizedExecutable === "node" || params.normalizedExecutable === "nodejs") {
    return [
      "#!/bin/sh",
      argvMarker,
      "set -eu",
      `exec ${quotePosixShellArg(params.interpreter.resolvedRealPath)} ${quotePosixShellArg(params.flag)} ${quotePosixShellArg(params.code)}`,
      "",
    ].join("\n");
  }
  return null;
}

type CachedInlineEvalScript = {
  path: string;
  mtimeMs: number;
  size: number;
};

function pruneInlineEvalCacheSync(params: {
  dir: string;
  targetPath?: string;
  incomingBytes: number;
  incomingFiles: 0 | 1;
}): { ok: true; remainingScripts: number } | { ok: false; message: string } {
  if (params.incomingBytes > INLINE_EVAL_CACHE_MAX_BYTES) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: inline-eval script exceeds cache limit" };
  }
  const now = Date.now();
  const scripts: CachedInlineEvalScript[] = [];
  try {
    for (const entry of fs.readdirSync(params.dir, { withFileTypes: true })) {
      const entryPath = path.join(params.dir, entry.name);
      if (params.targetPath && entryPath === params.targetPath) {
        continue;
      }
      if (MATERIALIZED_TEMP_PATTERN.test(entry.name)) {
        const stat = fs.lstatSync(entryPath);
        if (now - stat.mtimeMs > INLINE_EVAL_TEMP_MAX_AGE_MS) {
          fs.rmSync(entryPath, { force: true });
        }
        continue;
      }
      if (!MATERIALIZED_SCRIPT_PATTERN.test(entry.name)) {
        continue;
      }
      const stat = fs.lstatSync(entryPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fs.rmSync(entryPath, { force: true });
        continue;
      }
      if (now - stat.mtimeMs > INLINE_EVAL_CACHE_MAX_AGE_MS) {
        fs.rmSync(entryPath, { force: true });
        continue;
      }
      scripts.push({ path: entryPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    scripts.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = scripts.reduce((sum, script) => sum + script.size, 0);
    while (
      scripts.length + params.incomingFiles > INLINE_EVAL_CACHE_MAX_FILES ||
      totalBytes + params.incomingBytes > INLINE_EVAL_CACHE_MAX_BYTES
    ) {
      const oldest = scripts.shift();
      if (!oldest) {
        break;
      }
      fs.rmSync(oldest.path, { force: true });
      totalBytes -= oldest.size;
    }
    return { ok: true, remainingScripts: scripts.length + params.incomingFiles };
  } catch {
    return { ok: false, message: "SYSTEM_RUN_DENIED: unable to prune inline-eval cache" };
  }
}

function scheduleInlineEvalCacheSweep(inlineEvalDir: string): void {
  if (inlineEvalCacheSweepTimers.has(inlineEvalDir)) {
    return;
  }
  const timer = setInterval(() => {
    const result = pruneInlineEvalCacheSync({
      dir: inlineEvalDir,
      incomingBytes: 0,
      incomingFiles: 0,
    });
    if (!result.ok || result.remainingScripts === 0) {
      clearInterval(timer);
      inlineEvalCacheSweepTimers.delete(inlineEvalDir);
    }
  }, INLINE_EVAL_CACHE_SWEEP_INTERVAL_MS);
  timer.unref();
  inlineEvalCacheSweepTimers.set(inlineEvalDir, timer);
}

function ensureUserPrivateDirectory(dir: string): { ok: true } | { ok: false; message: string } {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, message: "SYSTEM_RUN_DENIED: inline-eval temp dir is unsafe" };
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && typeof stat.uid === "number" && stat.uid !== uid) {
      return { ok: false, message: "SYSTEM_RUN_DENIED: inline-eval temp dir owner mismatch" };
    }
    if ((stat.mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700);
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "SYSTEM_RUN_DENIED: unable to prepare inline-eval temp dir" };
  }
}

function writeMaterializedInlineEvalScriptSync(params: {
  normalizedExecutable: string;
  flag: string;
  code: string;
  originalArgv: string[];
  interpreter: InlineEvalInterpreterSnapshot;
  pythonVenvLauncher?: string;
}): { ok: true; scriptPath: string } | { ok: false; message: string } {
  const scriptBody = renderMaterializedInlineEvalScript(params);
  if (scriptBody === null) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: unable to materialize inline-eval script" };
  }
  const tmpDir = path.join(resolveStateDir(), "tmp");
  const tmp = ensureUserPrivateDirectory(tmpDir);
  if (!tmp.ok) {
    return tmp;
  }
  const inlineEvalDir = path.join(tmpDir, "inline-eval");
  const dir = ensureUserPrivateDirectory(inlineEvalDir);
  if (!dir.ok) {
    return dir;
  }

  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        interpreter: params.normalizedExecutable,
        flag: params.flag,
        code: params.code,
        originalArgv: params.originalArgv,
        interpreterSnapshot: params.interpreter,
        pythonVenvLauncher: params.pythonVenvLauncher,
        runtimeWrapper: "posix-shell-eval-v2",
      }),
    )
    .digest("hex");
  const scriptPath = path.join(inlineEvalDir, `${digest}.sh`);
  const scriptBytes = Buffer.byteLength(scriptBody);
  const pruned = pruneInlineEvalCacheSync({
    dir: inlineEvalDir,
    targetPath: scriptPath,
    incomingBytes: scriptBytes,
    incomingFiles: 1,
  });
  if (!pruned.ok) {
    return pruned;
  }
  const tmpScriptPath = path.join(
    inlineEvalDir,
    `.${digest}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpScriptPath, scriptBody, { flag: "wx", mode: 0o600 });
    fs.chmodSync(tmpScriptPath, 0o600);
    fs.renameSync(tmpScriptPath, scriptPath);
    fs.chmodSync(scriptPath, 0o600);
    scheduleInlineEvalCacheSweep(inlineEvalDir);
    return { ok: true, scriptPath };
  } catch {
    try {
      fs.rmSync(tmpScriptPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    return { ok: false, message: "SYSTEM_RUN_DENIED: unable to materialize inline-eval script" };
  }
}

function isMaterializedInlineEvalApprovalPlan(
  plan: SystemRunApprovalPlan | null | undefined,
): boolean {
  if (!plan?.commandPreview || !plan.mutableFileOperand) {
    return false;
  }
  const scriptPath = plan.argv[plan.mutableFileOperand.argvIndex];
  if (!scriptPath) {
    return false;
  }
  let scriptRealPath: string;
  try {
    scriptRealPath = fs.realpathSync(scriptPath);
  } catch {
    return false;
  }
  if (scriptRealPath !== plan.mutableFileOperand.path) {
    return false;
  }
  let inlineEvalDirRealPath: string;
  try {
    inlineEvalDirRealPath = fs.realpathSync(path.join(resolveStateDir(), "tmp", "inline-eval"));
  } catch {
    return false;
  }
  return path.dirname(scriptRealPath) === inlineEvalDirRealPath;
}

export function detectMaterializedInlineEvalApprovalHit(
  approvalPlan: SystemRunApprovalPlan | null,
): InterpreterInlineEvalHit | null {
  if (!approvalPlan || !isMaterializedInlineEvalApprovalPlan(approvalPlan)) {
    return null;
  }
  const scriptPath = approvalPlan.argv[approvalPlan.mutableFileOperand?.argvIndex ?? -1];
  if (!scriptPath) {
    return null;
  }
  try {
    const markerLine = fs.readFileSync(scriptPath, "utf8").split("\n", 3)[1];
    if (!markerLine?.startsWith(INLINE_EVAL_ARGV_MARKER)) {
      return null;
    }
    const encodedArgv = markerLine.slice(INLINE_EVAL_ARGV_MARKER.length);
    const decoded = JSON.parse(Buffer.from(encodedArgv, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || !decoded.every((entry) => typeof entry === "string")) {
      return null;
    }
    return detectInterpreterInlineEvalArgv(decoded);
  } catch {
    return null;
  }
}

export function materializeInlineEvalForApprovalSync(
  argv: string[],
  cwd?: string,
): { ok: true; command: MaterializedInlineEvalCommand | null } | { ok: false; message: string } {
  if (process.platform === "win32") {
    return { ok: true, command: null };
  }
  const hit = detectInterpreterInlineEvalArgv(argv);
  if (!hit) {
    return { ok: true, command: null };
  }
  if (/^pypy\d*$/.test(hit.normalizedExecutable)) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    };
  }
  const supportedInterpreter =
    /^(?:python|python\d+(?:\.\d+)*)$/.test(hit.normalizedExecutable) ||
    hit.normalizedExecutable === "node" ||
    hit.normalizedExecutable === "nodejs";
  if (!supportedInterpreter || (hit.flag !== "-c" && hit.flag !== "-e" && hit.flag !== "--eval")) {
    return { ok: true, command: null };
  }
  const codeIndex = resolveMaterializableInlineEvalCodeIndex(argv, hit.flag);
  if (codeIndex === null) {
    return { ok: true, command: null };
  }
  const code = argv[codeIndex] ?? "";
  const resolution = resolveCommandResolutionFromArgv(argv, cwd);
  const interpreter =
    resolution?.execution.resolvedPath && resolution.execution.resolvedRealPath
      ? {
          resolvedPath: resolution.execution.resolvedPath,
          resolvedRealPath: resolution.execution.resolvedRealPath,
        }
      : undefined;
  if (!interpreter) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: unable to resolve inline-eval interpreter" };
  }
  const pythonVenvLauncher = hit.normalizedExecutable.startsWith("python")
    ? resolvePythonVenvLauncher(interpreter)
    : undefined;
  if (pythonVenvLauncher && process.platform !== "darwin") {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    };
  }
  const materialized = writeMaterializedInlineEvalScriptSync({
    normalizedExecutable: hit.normalizedExecutable,
    flag: hit.flag,
    code,
    originalArgv: argv,
    interpreter,
    pythonVenvLauncher,
  });
  if (!materialized.ok) {
    return materialized;
  }
  return {
    ok: true,
    command: {
      argv: ["/bin/sh", materialized.scriptPath],
      scriptPath: materialized.scriptPath,
    },
  };
}
