import type { SourceSpan } from "./command-explainer/types.js";
import type { ExecSegmentSatisfiedBy } from "./exec-approvals-allowlist.js";
import { resolvePlannedSegmentArgv } from "./exec-approvals-analysis.js";
import type {
  ExecAuthorizationCandidate,
  ExecAuthorizationPlan,
} from "./exec-authorization-plan.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import type { SystemRunMutableFileBinding } from "./system-run-approval-binding.js";

type AuthorizedShellRenderMode = "safeBins" | "enforced";

type AuthorizedShellRenderResult = { ok: true; command: string } | { ok: false; reason: string };

type SourceReplacement = {
  startIndex: number;
  endIndex: number;
  text: string;
};

const SHELL_BARE_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/u;

function shellEscapeSingleArg(value: string): string {
  const singleQuoteEscape = `'"'"'`;
  return `'${value.replace(/'/g, singleQuoteEscape)}'`;
}

function renderBareShellToken(value: string): string {
  return value.length > 0 && SHELL_BARE_TOKEN_PATTERN.test(value)
    ? value
    : shellEscapeSingleArg(value);
}

function renderSourcePreservingArgv(argv: readonly string[]): string {
  return argv.map((token) => renderBareShellToken(token)).join(" ");
}

function hasUnquotedShellExpansionSource(value: string): boolean {
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let atWordStart = true;
  for (const char of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== "single" && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "single") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (/\s/u.test(char)) {
      atWordStart = true;
      continue;
    }
    if (char === "~" && atWordStart) {
      return true;
    }
    if (char === "{" || char === "*" || char === "?" || char === "[") {
      return true;
    }
    atWordStart = false;
  }
  return false;
}

function hasArgumentShellExpansionSource(candidate: ExecAuthorizationCandidate): boolean {
  const executableEnd = Math.max(
    0,
    candidate.sourceStep.executableSpan.endIndex - candidate.sourceStep.span.startIndex,
  );
  return hasUnquotedShellExpansionSource(candidate.sourceStep.text.slice(executableEnd));
}

function validateSpan(params: {
  command: string;
  span: SourceSpan;
  expectedText: string;
}): AuthorizedShellRenderResult {
  const { span } = params;
  if (
    !Number.isInteger(span.startIndex) ||
    !Number.isInteger(span.endIndex) ||
    span.startIndex < 0 ||
    span.endIndex > params.command.length ||
    span.startIndex >= span.endIndex
  ) {
    return { ok: false, reason: "invalid source span" };
  }
  if (params.command.slice(span.startIndex, span.endIndex) !== params.expectedText) {
    return { ok: false, reason: "source span mismatch" };
  }
  return { ok: true, command: "" };
}

function sourceStepSlice(params: {
  candidate: ExecAuthorizationCandidate;
  span: SourceSpan;
}): string {
  const relativeStart = Math.max(
    0,
    params.span.startIndex - params.candidate.sourceStep.span.startIndex,
  );
  const relativeEnd = Math.max(
    relativeStart,
    params.span.endIndex - params.candidate.sourceStep.span.startIndex,
  );
  return params.candidate.sourceStep.text.slice(relativeStart, relativeEnd);
}

function shouldRewriteCandidate(params: {
  mode: AuthorizedShellRenderMode;
  satisfiedBy: ExecSegmentSatisfiedBy | undefined;
}): boolean {
  if (params.mode === "enforced") {
    // Safe builtins (cd, :, true, false, pwd, test) are handled by the shell itself, not by an
    // external executable. Rewriting them to a resolved path (e.g. /usr/bin/cd) is semantically
    // wrong and does not strengthen PATH-shadowing protection, so enforced mode leaves them as-is.
    return params.satisfiedBy !== "safeBuiltins";
  }
  return params.satisfiedBy === "safeBins" || params.satisfiedBy === "inlineChain";
}

function hasDispatchWrapper(segment: ExecAuthorizationCandidate["sourceSegment"]): boolean {
  return (segment.resolution?.wrapperChain?.length ?? 0) > 0;
}

function replacementForCandidate(params: {
  command: string;
  candidate: ExecAuthorizationCandidate;
  mode: AuthorizedShellRenderMode;
  satisfiedBy: ExecSegmentSatisfiedBy | undefined;
}): AuthorizedShellRenderResult | SourceReplacement | null {
  if (params.mode === "enforced" && hasArgumentShellExpansionSource(params.candidate)) {
    return { ok: false, reason: "shell expansion in enforced arguments" };
  }
  if (!shouldRewriteCandidate({ mode: params.mode, satisfiedBy: params.satisfiedBy })) {
    return null;
  }
  const plannedArgv = resolvePlannedSegmentArgv(params.candidate.sourceSegment);
  if (!plannedArgv) {
    return { ok: false, reason: "segment execution plan unavailable" };
  }
  if (params.satisfiedBy === "safeBins" && hasArgumentShellExpansionSource(params.candidate)) {
    return { ok: false, reason: "shell expansion in safe-bin arguments" };
  }
  if (params.mode === "enforced" && params.candidate.transport.kind === "shell-wrapper") {
    return { ok: false, reason: "shell quoting required in wrapper payload" };
  }
  if (hasDispatchWrapper(params.candidate.sourceSegment)) {
    const spanResult = validateSpan({
      command: params.command,
      span: params.candidate.sourceStep.span,
      expectedText: params.candidate.sourceStep.text,
    });
    if (!spanResult.ok) {
      return spanResult;
    }
    return {
      startIndex: params.candidate.sourceStep.span.startIndex,
      endIndex: params.candidate.sourceStep.span.endIndex,
      text: renderSourcePreservingArgv(plannedArgv),
    };
  }
  const executable = plannedArgv[0];
  if (!executable) {
    return { ok: false, reason: "segment execution plan unavailable" };
  }
  const renderedExecutable = renderBareShellToken(executable);
  if (
    params.satisfiedBy === "safeBins" &&
    params.candidate.transport.kind === "shell-wrapper" &&
    renderedExecutable !== executable
  ) {
    return { ok: false, reason: "shell quoting required in wrapper payload" };
  }
  const spanResult = validateSpan({
    command: params.command,
    span: params.candidate.sourceStep.executableSpan,
    expectedText: sourceStepSlice({
      candidate: params.candidate,
      span: params.candidate.sourceStep.executableSpan,
    }),
  });
  if (!spanResult.ok) {
    return spanResult;
  }
  return {
    startIndex: params.candidate.sourceStep.executableSpan.startIndex,
    endIndex: params.candidate.sourceStep.executableSpan.endIndex,
    text: renderedExecutable,
  };
}

function collectCandidateReplacements(params: {
  command: string;
  candidates: readonly ExecAuthorizationCandidate[];
  mode: AuthorizedShellRenderMode;
  segmentSatisfiedBy: readonly ExecSegmentSatisfiedBy[];
}): AuthorizedShellRenderResult | SourceReplacement[] {
  const replacements: SourceReplacement[] = [];
  for (const [index, candidate] of params.candidates.entries()) {
    const replacement = replacementForCandidate({
      command: params.command,
      candidate,
      mode: params.mode,
      satisfiedBy: params.segmentSatisfiedBy[index],
    });
    if (!replacement) {
      continue;
    }
    if ("ok" in replacement) {
      return replacement;
    }
    replacements.push(replacement);
  }
  return replacements;
}

function applyReplacements(params: {
  command: string;
  replacements: readonly SourceReplacement[];
}): AuthorizedShellRenderResult {
  const sorted = params.replacements.toSorted((left, right) => left.startIndex - right.startIndex);
  let previousEnd = -1;
  for (const replacement of sorted) {
    if (replacement.startIndex < previousEnd) {
      return { ok: false, reason: "overlapping replacement ranges" };
    }
    previousEnd = replacement.endIndex;
  }

  let command = params.command;
  for (const replacement of sorted.toReversed()) {
    command =
      command.slice(0, replacement.startIndex) +
      replacement.text +
      command.slice(replacement.endIndex);
  }
  return { ok: true, command };
}

export function buildAuthorizedShellCommandFromPlan(params: {
  plan: ExecAuthorizationPlan;
  mode: AuthorizedShellRenderMode;
  segmentSatisfiedBy?: readonly ExecSegmentSatisfiedBy[];
}): AuthorizedShellRenderResult {
  if (!params.plan.ok) {
    return { ok: false, reason: params.plan.reason };
  }
  if (params.plan.dialect !== "posix-shell") {
    return { ok: false, reason: "unsupported command dialect" };
  }

  const candidates = params.plan.groups.flatMap((group) => group.candidates);
  const segmentSatisfiedBy = params.segmentSatisfiedBy ?? [];
  if (segmentSatisfiedBy.length !== candidates.length) {
    return { ok: false, reason: "segment metadata mismatch" };
  }

  const replacements = collectCandidateReplacements({
    command: params.plan.originalCommand,
    candidates,
    mode: params.mode,
    segmentSatisfiedBy,
  });
  if ("ok" in replacements) {
    return replacements;
  }
  return applyReplacements({
    command: params.plan.originalCommand,
    replacements,
  });
}

/** Pins reviewed dispatches while retaining argument expansion and wrapper semantics. */
export function buildReviewedShellCommandFromPlan(params: {
  plan: ExecAuthorizationPlan;
  binding: SystemRunMutableFileBinding;
  segmentSatisfiedBy?: readonly ExecSegmentSatisfiedBy[];
}): AuthorizedShellRenderResult {
  if (!params.plan.ok) {
    return { ok: false, reason: params.plan.reason };
  }
  if (params.plan.dialect !== "posix-shell") {
    return { ok: false, reason: "unsupported command dialect" };
  }
  const candidates = params.plan.groups.flatMap((group) => group.candidates);
  if (params.segmentSatisfiedBy && params.segmentSatisfiedBy.length !== candidates.length) {
    return { ok: false, reason: "segment metadata mismatch" };
  }
  const replacements: SourceReplacement[] = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (params.segmentSatisfiedBy?.[candidateIndex] === "safeBuiltins") {
      continue;
    }
    const { sourceSegment: segment, sourceStep: step } = candidate;
    const sourceArgv = segment.sourceArgv ?? segment.argv;
    const { dispatchChain } = resolveExecWrapperTrustPlan(sourceArgv);
    if (
      candidate.transport.kind !== "direct" ||
      segment.resolution?.policyBlocked ||
      !dispatchChain
    ) {
      return { ok: false, reason: "dispatch chain cannot be rendered" };
    }
    if (
      step.argvSpans?.length !== sourceArgv.length ||
      step.argv.length !== sourceArgv.length ||
      !step.argv.every((token, index) => token === sourceArgv[index])
    ) {
      return { ok: false, reason: "argument source spans unavailable" };
    }
    const stepSpanResult = validateSpan({
      command: params.plan.originalCommand,
      span: step.span,
      expectedText: step.text,
    });
    if (!stepSpanResult.ok) {
      return stepSpanResult;
    }
    for (const [index, argv] of dispatchChain.entries()) {
      const argvIndex = sourceArgv.length - argv.length;
      const span = step.argvSpans[argvIndex];
      if (
        !span ||
        !argv.every((token, offset) => token === sourceArgv[argvIndex + offset]) ||
        span.startIndex < step.span.startIndex ||
        span.endIndex > step.span.endIndex
      ) {
        return { ok: false, reason: "dispatch source span mismatch" };
      }
      const operandArgv = index === dispatchChain.length - 1 ? segment.argv : argv.slice(0, 1);
      const operand = params.binding.operands.find(
        (entry) =>
          entry.executable === true &&
          entry.snapshot.argvIndex === 0 &&
          entry.argv.length === operandArgv.length &&
          entry.argv.every((token, offset) => token === operandArgv[offset]),
      );
      if (!operand?.executable || !operand.invocationPath.startsWith("/")) {
        return { ok: false, reason: "bound executable unavailable" };
      }
      const spanResult = validateSpan({
        command: params.plan.originalCommand,
        span,
        expectedText: sourceStepSlice({ candidate, span }),
      });
      if (!spanResult.ok) {
        return spanResult;
      }
      replacements.push({
        startIndex: span.startIndex,
        endIndex: span.endIndex,
        // Quote even ordinary paths: aliases can themselves be named absolute paths.
        text: shellEscapeSingleArg(operand.invocationPath),
      });
    }
  }
  if (replacements.length === 0) {
    return { ok: false, reason: "no dispatches to render" };
  }
  return applyReplacements({ command: params.plan.originalCommand, replacements });
}
