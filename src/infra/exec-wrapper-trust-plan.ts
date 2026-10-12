// Builds the trust plan for exec wrappers before commands are launched.
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import {
  type DispatchWrapperInvocation,
  MAX_DISPATCH_WRAPPER_DEPTH,
  resolveDispatchWrapperTrustPlan,
  unwrapKnownDispatchWrapperInvocation,
} from "./dispatch-wrapper-resolution.js";
import {
  extractBindableShellWrapperInlineCommand,
  extractShellWrapperInlineCommand,
  hasPosixShellStartupBeforeInlineCommand,
  isShellWrapperExecutable,
  unwrapKnownShellMultiplexerInvocation,
} from "./shell-wrapper-resolution.js";

type ExecWrapperTrustPlan = {
  // Null when policy projection cannot describe every actual executable dispatch.
  dispatchChain: string[][] | null;
  argv: string[];
  policyArgv: string[];
  wrapperChain: string[];
  wrapperInvocations: DispatchWrapperInvocation[];
  policyBlocked: boolean;
  blockedWrapper?: string;
  shellWrapperExecutable: boolean;
  shellInlineCommand: string | null;
};

const TRANSPARENT_SHELL_ARGV_CARRIERS = new Set(["builtin", "command", "exec"]);

type ShellArgvCarrierUnwrapResult =
  | { kind: "not-wrapper" }
  | { kind: "blocked"; wrapper: string }
  | { kind: "unwrapped"; wrapper: string; argv: string[] };

function commandCarrierUsesDefaultPathSearch(argv: string[]): boolean {
  if (argv[0]?.trim() !== "command") {
    return false;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--" || !token.startsWith("-")) {
      return false;
    }
    if (/^-[^-]*p/u.test(token)) {
      return true;
    }
  }
  return false;
}

function unwrapTransparentShellArgvCarrierInvocation(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): ShellArgvCarrierUnwrapResult {
  if (platform === "win32") {
    return { kind: "not-wrapper" };
  }
  const token0 = argv[0]?.trim();
  if (!token0) {
    return { kind: "not-wrapper" };
  }
  if (!TRANSPARENT_SHELL_ARGV_CARRIERS.has(token0)) {
    return { kind: "not-wrapper" };
  }
  if (commandCarrierUsesDefaultPathSearch(argv)) {
    return { kind: "blocked", wrapper: token0 };
  }
  const unwrapped = resolveCarrierCommandArgv(argv, 0, { includeExec: true });
  return unwrapped && unwrapped.length > 0
    ? { kind: "unwrapped", wrapper: token0, argv: unwrapped }
    : { kind: "blocked", wrapper: token0 };
}

/**
 * Resolves transparent dispatch wrappers into the executable that policy should inspect.
 * Shell multiplexers keep their original argv as the trust target while exposing the
 * nested shell command for shell-specific approval checks.
 */
export function resolveExecWrapperTrustPlan(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
  platform: NodeJS.Platform = process.platform,
): ExecWrapperTrustPlan {
  let current = argv;
  let policyArgv = argv;
  let sawShellMultiplexer = false;
  let dispatchChainComplete = true;
  const wrapperChain: string[] = [];
  const wrapperInvocations: DispatchWrapperInvocation[] = [];
  const blocked = (
    blockedWrapper: string,
    blockedArgv = current,
    blockedPolicyArgv = policyArgv,
  ): ExecWrapperTrustPlan => ({
    dispatchChain: null,
    argv: blockedArgv,
    policyArgv: blockedPolicyArgv,
    wrapperChain,
    wrapperInvocations,
    policyBlocked: true,
    blockedWrapper,
    shellWrapperExecutable: false,
    shellInlineCommand: null,
  });
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const dispatchPlan = resolveDispatchWrapperTrustPlan(
      current,
      maxDepth - wrapperChain.length,
      platform,
    );
    wrapperInvocations.push(...dispatchPlan.wrapperInvocations);
    dispatchChainComplete &&= dispatchPlan.dispatchChainComplete;
    if (dispatchPlan.policyBlocked) {
      return blocked(
        dispatchPlan.blockedWrapper ?? current[0] ?? "unknown",
        dispatchPlan.argv,
        dispatchPlan.argv,
      );
    }
    if (dispatchPlan.wrappers.length > 0) {
      wrapperChain.push(...dispatchPlan.wrappers);
      current = dispatchPlan.argv;
      if (!sawShellMultiplexer) {
        policyArgv = current;
      }
      if (wrapperChain.length >= maxDepth) {
        break;
      }
      continue;
    }

    const carrier = unwrapTransparentShellArgvCarrierInvocation(current, platform);
    const isMultiplexer = carrier.kind === "not-wrapper";
    const shellWrapper = isMultiplexer ? unwrapKnownShellMultiplexerInvocation(current) : carrier;
    if (shellWrapper.kind === "blocked") {
      return blocked(shellWrapper.wrapper);
    }
    if (shellWrapper.kind === "not-wrapper") {
      break;
    }
    dispatchChainComplete = false;
    wrapperChain.push(shellWrapper.wrapper);
    wrapperInvocations.push({ wrapper: shellWrapper.wrapper, sourceArgv: [...current] });
    if (!sawShellMultiplexer) {
      // Trust policy must see the multiplexer applet, not only the shell it launches.
      policyArgv = isMultiplexer ? current : shellWrapper.argv;
      sawShellMultiplexer = isMultiplexer;
    }
    current = shellWrapper.argv;
    if (wrapperChain.length >= maxDepth) {
      break;
    }
  }

  if (wrapperChain.length >= maxDepth) {
    for (const unwrap of [
      unwrapKnownDispatchWrapperInvocation,
      unwrapTransparentShellArgvCarrierInvocation,
      unwrapKnownShellMultiplexerInvocation,
    ]) {
      const overflow = unwrap(current, platform);
      if (overflow.kind !== "not-wrapper") {
        return blocked(overflow.wrapper);
      }
    }
  }

  const rawExecutable = current[0]?.trim() ?? "";
  const shellWrapperExecutable =
    rawExecutable.length > 0 && isShellWrapperExecutable(rawExecutable);
  return {
    dispatchChain:
      dispatchChainComplete &&
      rawExecutable &&
      (!shellWrapperExecutable ||
        (extractShellWrapperInlineCommand(current) === null &&
          !hasPosixShellStartupBeforeInlineCommand(current)))
        ? [...wrapperInvocations.map(({ sourceArgv }) => sourceArgv), current]
        : null,
    argv: current,
    policyArgv,
    wrapperChain,
    wrapperInvocations,
    policyBlocked: false,
    shellWrapperExecutable,
    shellInlineCommand: shellWrapperExecutable
      ? extractBindableShellWrapperInlineCommand(current)
      : null,
  };
}
