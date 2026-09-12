import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./crypto-digest.js";
// Binds system-run approval requests to stable command identities.
import type {
  ExecCommandSegment,
  SystemRunApprovalBinding,
  SystemRunApprovalFileOperand,
} from "./exec-approvals.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";
import {
  type ExecutableResolution,
  resolveCommandResolutionFromArgv,
} from "./exec-command-resolution.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import { normalizeHostOverrideEnvVarKey } from "./host-env-security.js";
import { resolveEnvironmentValue } from "./process-env.js";
import { extractShellCommandFromArgv } from "./system-run-command.js";
import { snapshotFileOperandAtPath } from "./system-run-file-snapshot.js";
import {
  isSystemRunCommandTextBoundInterpreterInvocation,
  resolveSystemRunMutableFileOperandTarget,
  unwrapSystemRunMutableFileOperandArgv,
} from "./system-run-mutable-file-operand.js";
import {
  looksLikeExplicitPathToken,
  pathLooksMutableForShellPayloadSync,
} from "./system-run-mutable-file-policy.js";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";
import { hasPosixShellStartupEnvironment } from "./system-run-shell-file-operand.js";
import { analyzeWindowsShellCommand } from "./windows-shell-command.js";

export const APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval script operand changed before execution";

type NormalizedSystemRunEnvEntry = [key: string, value: string];

function normalizeSystemRunEnvEntries(env: unknown): NormalizedSystemRunEnvEntry[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return [];
  }
  const entries: NormalizedSystemRunEnvEntry[] = [];
  for (const [rawKey, rawValue] of Object.entries(env as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const key = normalizeHostOverrideEnvVarKey(rawKey);
    if (!key) {
      continue;
    }
    entries.push([key, rawValue]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries;
}

function hashSystemRunEnvEntries(entries: NormalizedSystemRunEnvEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  return sha256Hex(JSON.stringify(entries));
}

export function buildSystemRunApprovalEnvBinding(env: unknown): {
  envHash: string | null;
  envKeys: string[];
} {
  const entries = normalizeSystemRunEnvEntries(env);
  return {
    envHash: hashSystemRunEnvEntries(entries),
    envKeys: entries.map(([key]) => key),
  };
}

export function buildSystemRunApprovalBinding(params: {
  argv: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  env?: unknown;
}): { binding: SystemRunApprovalBinding; envKeys: string[] } {
  const envBinding = buildSystemRunApprovalEnvBinding(params.env);
  return {
    binding: {
      argv: normalizeStringArray(params.argv),
      cwd: normalizeNonEmptyString(params.cwd),
      agentId: normalizeNonEmptyString(params.agentId),
      sessionKey: normalizeNonEmptyString(params.sessionKey),
      envHash: envBinding.envHash,
    },
    envKeys: envBinding.envKeys,
  };
}

function argvMatches(expectedArgv: string[], actualArgv: string[]): boolean {
  if (expectedArgv.length === 0 || expectedArgv.length !== actualArgv.length) {
    return false;
  }
  for (let i = 0; i < expectedArgv.length; i += 1) {
    if (expectedArgv[i] !== actualArgv[i]) {
      return false;
    }
  }
  return true;
}

export type SystemRunApprovalMatchResult =
  | { ok: true }
  | {
      ok: false;
      code: "APPROVAL_REQUEST_MISMATCH" | "APPROVAL_ENV_BINDING_MISSING" | "APPROVAL_ENV_MISMATCH";
      message: string;
      details?: Record<string, unknown>;
    };

type SystemRunApprovalMismatch = Extract<SystemRunApprovalMatchResult, { ok: false }>;

const APPROVAL_REQUEST_MISMATCH_MESSAGE = "approval id does not match request";

function requestMismatch(details?: Record<string, unknown>): SystemRunApprovalMatchResult {
  return {
    ok: false,
    code: "APPROVAL_REQUEST_MISMATCH",
    message: APPROVAL_REQUEST_MISMATCH_MESSAGE,
    details,
  };
}

function matchSystemRunApprovalEnvHash(params: {
  expectedEnvHash: string | null;
  actualEnvHash: string | null;
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  // Fail closed if callers provide inconsistent hash/key state. This guards against
  // normalization drift between approval and execution paths.
  if (!params.expectedEnvHash && !params.actualEnvHash && params.actualEnvKeys.length > 0) {
    return {
      ok: false,
      code: "APPROVAL_ENV_BINDING_MISSING",
      message: "approval id missing env binding for requested env overrides",
      details: { envKeys: params.actualEnvKeys },
    };
  }
  if (!params.expectedEnvHash && !params.actualEnvHash) {
    return { ok: true };
  }
  if (!params.expectedEnvHash && params.actualEnvHash) {
    return {
      ok: false,
      code: "APPROVAL_ENV_BINDING_MISSING",
      message: "approval id missing env binding for requested env overrides",
      details: { envKeys: params.actualEnvKeys },
    };
  }
  if (params.expectedEnvHash !== params.actualEnvHash) {
    return {
      ok: false,
      code: "APPROVAL_ENV_MISMATCH",
      message: "approval id env binding mismatch",
      details: {
        envKeys: params.actualEnvKeys,
        expectedEnvHash: params.expectedEnvHash,
        actualEnvHash: params.actualEnvHash,
      },
    };
  }
  return { ok: true };
}

export function matchSystemRunApprovalBinding(params: {
  expected: SystemRunApprovalBinding;
  actual: SystemRunApprovalBinding;
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  if (!argvMatches(params.expected.argv, params.actual.argv)) {
    return requestMismatch();
  }
  if (params.expected.cwd !== params.actual.cwd) {
    return requestMismatch();
  }
  if (params.expected.agentId !== params.actual.agentId) {
    return requestMismatch();
  }
  if (params.expected.sessionKey !== params.actual.sessionKey) {
    return requestMismatch();
  }
  return matchSystemRunApprovalEnvHash({
    expectedEnvHash: params.expected.envHash,
    actualEnvHash: params.actual.envHash,
    actualEnvKeys: params.actualEnvKeys,
  });
}

export function missingSystemRunApprovalBinding(params: {
  actualEnvKeys: string[];
}): SystemRunApprovalMatchResult {
  return requestMismatch({
    envKeys: params.actualEnvKeys,
  });
}

export function toSystemRunApprovalMismatchError(params: {
  runId: string;
  match: SystemRunApprovalMismatch;
}): { ok: false; message: string; details: Record<string, unknown> } {
  const details: Record<string, unknown> = {
    code: params.match.code,
    runId: params.runId,
  };
  if (params.match.details) {
    Object.assign(details, params.match.details);
  }
  return {
    ok: false,
    message: params.match.message,
    details,
  };
}

/** Captures file identity for a mutable script operand that approval is bound to. */
export function resolveMutableFileOperandSnapshotSync(params: {
  argv: string[];
  cwd: string | undefined;
  shellCommand: string | null;
}): { ok: true; snapshot: SystemRunApprovalFileOperand | null } | { ok: false; message: string } {
  const target = resolveSystemRunMutableFileOperandTarget(params);
  if (!target.ok) {
    return target;
  }
  if (target.argvIndex === null) {
    return { ok: true, snapshot: null };
  }
  const operand = params.argv[target.argvIndex]?.trim();
  if (!operand) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a stable script operand",
    };
  }
  return snapshotFileOperandAtPath({
    argvIndex: target.argvIndex,
    filePath: path.resolve(params.cwd ?? process.cwd(), operand),
  });
}

export type SystemRunMutableFileBinding = {
  commands: string[][];
  operands: Array<
    { argv: string[]; pathSearch?: { path?: string; pathExt?: string } } & (
      | { kind: "mutable"; snapshot: SystemRunApprovalFileOperand; executable?: true }
      | {
          kind: "identity";
          snapshot: { argvIndex: number; path: string; sha256?: never };
          executable: true;
        }
    )
  >;
};

type SystemRunMutableFileBindingCommand =
  | { kind: "argv"; argv: string[]; shellCommand?: string | null }
  | { kind: "segments"; segments: ExecCommandSegment[] }
  | { kind: "shell"; text: string };

type SystemRunMutableFileBindingResult =
  | { ok: true; binding: SystemRunMutableFileBinding }
  | { ok: false; message: string };

const SHELL_CWD_MUTATORS = new Set(["cd", "chdir", "popd", "pushd"]);
const SHELL_BUILTIN_DISPATCHERS = new Set(["builtin", "command"]);

function prepareMutableFileBindingsForArgv(params: {
  commands: readonly string[][];
  cwd?: string;
}): SystemRunMutableFileBindingResult {
  const operands: SystemRunMutableFileBinding["operands"] = [];
  const commands: string[][] = [];
  const seen = new Set<string>();
  for (const argv of params.commands) {
    const key = JSON.stringify(argv);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    commands.push([...argv]);
    const prepared = resolveMutableFileOperandSnapshotSync({
      argv,
      cwd: params.cwd,
      shellCommand: extractShellCommandFromArgv(argv),
    });
    if (!prepared.ok) {
      if (
        prepared.message ===
          "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command" &&
        isSystemRunCommandTextBoundInterpreterInvocation(argv)
      ) {
        continue;
      }
      return prepared;
    }
    if (prepared.snapshot) {
      operands.push({ kind: "mutable", argv: [...argv], snapshot: prepared.snapshot });
    }
  }
  return {
    ok: true,
    binding: { commands, operands },
  };
}

function prepareMutableFileBindingsForSegments(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): SystemRunMutableFileBindingResult {
  if (params.segments.length === 0) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind this command",
    };
  }
  const ordinaryCommands: string[][] = [];
  for (const [index, segment] of params.segments.entries()) {
    const effectiveArgv = unwrapSystemRunMutableFileOperandArgv(segment.argv);
    const executableIndex = SHELL_BUILTIN_DISPATCHERS.has(effectiveArgv[0]?.trim() ?? "") ? 1 : 0;
    const executable = effectiveArgv[executableIndex]?.trim() ?? "";
    if (
      hasPosixShellStartupEnvironment({
        argv: segment.argv,
        executable,
        env: params.env,
      })
    ) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup environment",
      };
    }
    if (executable && (executable === "." || executable === "source")) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell source operands",
      };
    }
    if (SHELL_CWD_MUTATORS.has(executable) && index < params.segments.length - 1) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind commands after cwd changes",
      };
    }
    const resolvedExecutable =
      segment.resolution?.execution.resolvedRealPath ?? segment.resolution?.execution.resolvedPath;
    if (
      executable &&
      !looksLikeExplicitPathToken(executable) &&
      segment.resolution &&
      !resolvedExecutable
    ) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval requires a resolved executable",
      };
    }
    ordinaryCommands.push(segment.argv);
  }
  const ordinary = prepareMutableFileBindingsForArgv({
    commands: ordinaryCommands,
    cwd: params.cwd,
  });
  if (!ordinary.ok) {
    return ordinary;
  }
  const executables = prepareSystemRunExecutableIdentityBinding({ ...params, shellCommand: true });
  if (!executables.ok) {
    return executables;
  }
  return {
    ok: true,
    binding: {
      commands: ordinary.binding.commands,
      operands: [...ordinary.binding.operands, ...executables.binding.operands],
    },
  };
}

/** In-memory executable identities; wire approval plans retain their script snapshot shape. */
export function prepareSystemRunExecutableIdentityBinding(params: {
  segments: ExecCommandSegment[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  shellCommand: boolean;
}): SystemRunMutableFileBindingResult {
  const operands: SystemRunMutableFileBinding["operands"] = [];
  for (const segment of params.segments) {
    const executions: Array<{ argv: string[]; execution: ExecutableResolution | undefined }> = [];
    const plan = resolveExecWrapperTrustPlan(segment.sourceArgv ?? segment.argv);
    let shellCommandPosition = params.shellCommand;
    for (const { wrapper, sourceArgv } of plan.wrapperInvocations) {
      // An external wrapper dispatches these names through PATH, not as shell builtins.
      if (
        shellCommandPosition &&
        (wrapper === "builtin" || wrapper === "command" || wrapper === "exec")
      ) {
        if (wrapper === "exec") {
          shellCommandPosition = false;
        }
        continue;
      }
      shellCommandPosition = false;
      const argv = sourceArgv.slice(0, 1);
      const execution = resolveCommandResolutionFromArgv(
        argv,
        params.cwd,
        params.env,
        process.platform,
        { useCache: false },
      )?.execution;
      if (!execution?.resolvedRealPath && !execution?.resolvedPath) {
        return { ok: false, message: "SYSTEM_RUN_DENIED: approval requires a resolved executable" };
      }
      executions.push({ argv, execution });
    }
    executions.push({ argv: segment.argv, execution: segment.resolution?.execution });
    for (const { argv, execution } of executions) {
      const resolvedExecutable = execution?.resolvedRealPath ?? execution?.resolvedPath;
      if (!execution || !resolvedExecutable) {
        continue;
      }
      let realPath: string;
      try {
        realPath = fs.realpathSync(resolvedExecutable);
      } catch {
        return { ok: false, message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE };
      }
      const pathSearch = !looksLikeExplicitPathToken(execution.rawExecutable)
        ? {
            path:
              resolveEnvironmentValue(params.env, "PATH") ??
              resolveEnvironmentValue(process.env, "PATH") ??
              "",
            pathExt:
              resolveEnvironmentValue(params.env, "PATHEXT") ??
              resolveEnvironmentValue(process.env, "PATHEXT") ??
              ".EXE;.CMD;.BAT;.COM",
          }
        : undefined;
      if (pathLooksMutableForShellPayloadSync(resolvedExecutable)) {
        const snapshot = snapshotFileOperandAtPath({ argvIndex: 0, filePath: realPath });
        if (!snapshot.ok) {
          return snapshot;
        }
        operands.push({
          kind: "mutable",
          argv: [...argv],
          snapshot: snapshot.snapshot,
          executable: true,
          pathSearch,
        });
      } else {
        operands.push({
          kind: "identity",
          argv: [...argv],
          snapshot: { argvIndex: 0, path: realPath },
          executable: true,
          pathSearch,
        });
      }
    }
  }
  return { ok: true, binding: { commands: [], operands } };
}

/** Captures executable identities and mutable file bytes an approval would release. */
export async function prepareSystemRunMutableFileBinding(params: {
  command: SystemRunMutableFileBindingCommand;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<SystemRunMutableFileBindingResult> {
  if (params.command.kind === "argv") {
    const prepared = resolveMutableFileOperandSnapshotSync({
      argv: params.command.argv,
      cwd: params.cwd,
      shellCommand: params.command.shellCommand ?? extractShellCommandFromArgv(params.command.argv),
    });
    if (!prepared.ok) {
      return prepared;
    }
    return {
      ok: true,
      binding: {
        commands: [[...params.command.argv]],
        operands: prepared.snapshot
          ? [{ kind: "mutable", argv: [...params.command.argv], snapshot: prepared.snapshot }]
          : [],
      },
    };
  }
  if (params.command.kind === "segments") {
    return prepareMutableFileBindingsForSegments({
      segments: params.command.segments,
      cwd: params.cwd,
      env: params.env,
    });
  }

  const commandText = params.command.text.trim();
  if (!commandText) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a command binding",
    };
  }
  if (params.env?.BASH_ENV?.trim() || params.env?.ENV?.trim()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell startup environment",
    };
  }
  if ((params.platform ?? process.platform) === "win32") {
    const analysis = analyzeWindowsShellCommand({
      command: commandText,
      cwd: params.cwd,
      env: params.env,
      platform: "win32",
    });
    if (!analysis.ok || analysis.segments.length === 0) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this command",
      };
    }
    return prepareMutableFileBindingsForSegments({
      segments: analysis.segments,
      cwd: params.cwd,
      env: params.env,
    });
  }

  const plan = await planShellAuthorization({
    command: commandText,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (!plan.ok) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind this command",
    };
  }
  if (plan.groups.some((group) => group.candidates.length > 1)) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind shell pipelines",
    };
  }
  const segments = plan.groups.flatMap((group) =>
    group.candidates.map((candidate) => candidate.sourceSegment),
  );
  return prepareMutableFileBindingsForSegments({ segments, cwd: params.cwd, env: params.env });
}

/** Revalidates approved executable identities and bytes after awaited approval work. */
export async function revalidateSystemRunMutableFileBinding(params: {
  binding: SystemRunMutableFileBinding;
  cwd?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  // Carry the prepared argv forward instead of reparsing after the approval;
  // parser drift must not change which executable operands were authorized.
  const current = prepareMutableFileBindingsForArgv({
    commands: params.binding.commands,
    cwd: params.cwd,
  });
  if (!current.ok) {
    return { ok: false, message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE };
  }
  const signature = (binding: SystemRunMutableFileBinding) =>
    binding.operands
      .filter((operand) => !operand.executable)
      .map(({ argv, snapshot }) =>
        JSON.stringify([argv, snapshot.argvIndex, snapshot.path, snapshot.sha256]),
      )
      .toSorted();
  const expected = signature(params.binding);
  const actual = signature(current.binding);
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    return { ok: false, message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE };
  }
  for (const operand of params.binding.operands) {
    if (!operand.executable) {
      continue;
    }
    const env = operand.pathSearch
      ? {
          ...process.env,
          ...(operand.pathSearch.path !== undefined ? { PATH: operand.pathSearch.path } : {}),
          ...(operand.pathSearch.pathExt !== undefined
            ? { PATHEXT: operand.pathSearch.pathExt }
            : {}),
        }
      : undefined;
    const resolution = resolveCommandResolutionFromArgv(
      operand.argv,
      params.cwd,
      env,
      process.platform,
      {
        useCache: false,
      },
    );
    const resolvedPath =
      resolution?.execution.resolvedRealPath ?? resolution?.execution.resolvedPath;
    if (!resolvedPath || resolvedPath !== operand.snapshot.path) {
      return { ok: false, message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE };
    }
    if (operand.kind === "mutable") {
      const snapshot = snapshotFileOperandAtPath({ argvIndex: 0, filePath: resolvedPath });
      if (!snapshot.ok || snapshot.snapshot.sha256 !== operand.snapshot.sha256) {
        return { ok: false, message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE };
      }
    }
  }
  return { ok: true };
}

/** Prepares an opaque revalidator so callers cannot replace the approved snapshot. */
export async function prepareSystemRunMutableFileApproval(params: {
  command: string;
  cwd?: string;
}): Promise<
  | {
      ok: true;
      requiresOneShot: boolean;
      revalidate: () => Promise<{ ok: true } | { ok: false; message: string }>;
    }
  | { ok: false; message: string }
> {
  const prepared = await prepareSystemRunMutableFileBinding({
    command: { kind: "shell", text: params.command },
    cwd: params.cwd,
  });
  if (!prepared.ok) {
    return prepared;
  }
  const binding = prepared.binding;
  return {
    ok: true,
    requiresOneShot: binding.operands.some((operand) => operand.kind === "mutable"),
    revalidate: async () =>
      await revalidateSystemRunMutableFileBinding({ binding, cwd: params.cwd }),
  };
}
