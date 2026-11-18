import {
  tokenizer,
  type AnyNode,
  type CallExpression,
  type Identifier,
  type MemberExpression,
  type ObjectExpression,
} from "acorn";
import {
  buildCodeModeScriptParseSource,
  parseCodeModeScriptSyntax,
} from "../../../agents/code-mode-script-syntax.js";
import { SESSION_PR_AUTO_FIX_CHECK } from "../../../shared/session-pr-auto-fix.js";

type TriggerScriptMigration =
  | { kind: "current" }
  | { kind: "unsupported" }
  | { kind: "supported"; script: string };

type SyntaxVisit = { node: AnyNode; ancestors: AnyNode[] };
type SourceEdit = { start: number; end: number; replacement: string };

function sourceContainsComment(source: string): boolean {
  let hasComment = false;
  const tokens = tokenizer(source, {
    ecmaVersion: "latest",
    onComment: () => {
      hasComment = true;
    },
  });
  while (tokens.getToken().type.label !== "eof") {
    if (hasComment) {
      return true;
    }
  }
  return hasComment;
}

function isSyntaxNode(value: unknown): value is AnyNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number"
  );
}

function collectSyntaxVisits(node: AnyNode, ancestors: AnyNode[] = []): SyntaxVisit[] {
  const visits: SyntaxVisit[] = [{ node, ancestors }];
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isSyntaxNode(child)) {
        visits.push(...collectSyntaxVisits(child, [...ancestors, node]));
      }
    }
  }
  return visits;
}

function isNoncomputedPropertyName(node: AnyNode, parent: AnyNode | undefined): boolean {
  return (
    (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
    (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
  );
}

function isNamedMember(node: AnyNode | undefined, name: string): node is MemberExpression {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === name
  );
}

function legacyToolCall(
  node: AnyNode,
): { call: CallExpression; tool: Identifier; args: ObjectExpression } | undefined {
  if (node.type !== "CallExpression") {
    return undefined;
  }
  const callee = node.callee;
  if (
    !isNamedMember(callee, "call") ||
    callee.optional ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "tools" ||
    node.optional ||
    node.arguments.length !== 2
  ) {
    return undefined;
  }
  const [toolName, args] = node.arguments;
  return toolName?.type === "Literal" &&
    toolName.value === "exec" &&
    args?.type === "ObjectExpression" &&
    args.properties.every(
      (property) =>
        property.type === "Property" &&
        property.kind === "init" &&
        !property.computed &&
        !property.method,
    )
    ? { call: node, tool: callee.object, args }
    : undefined;
}

/** Rewrite only the exact v2026.7.1 Cron trigger idiom; custom legacy code stays untouched. */
export function migrateLegacyCronTriggerScript(script: string): TriggerScriptMigration {
  const parsed = parseCodeModeScriptSyntax(script);
  if (!parsed.ok) {
    return { kind: "unsupported" };
  }
  const wrapper = parsed.program.body[0];
  if (
    wrapper?.type !== "ExpressionStatement" ||
    wrapper.expression.type !== "ArrowFunctionExpression" ||
    wrapper.expression.body.type !== "BlockStatement"
  ) {
    return { kind: "unsupported" };
  }
  const body = wrapper.expression.body;
  const visits = collectSyntaxVisits(body);
  const accessesLegacyGlobal = visits.some(({ node, ancestors }) => {
    if (node.type !== "MemberExpression") {
      return false;
    }
    const receiver = node.object;
    const isGlobalObject = receiver.type === "Identifier" && receiver.name === "globalThis";
    const isTopLevelThis =
      receiver.type === "ThisExpression" &&
      !ancestors.some(
        (ancestor) =>
          ancestor.type === "FunctionDeclaration" || ancestor.type === "FunctionExpression",
      );
    if (!isGlobalObject && !isTopLevelThis) {
      return false;
    }
    const property = node.property;
    const name = node.computed
      ? property.type === "Literal"
        ? property.value
        : undefined
      : property.type === "Identifier"
        ? property.name
        : undefined;
    return name === "tools" || name === "ALL_TOOLS";
  });
  if (accessesLegacyGlobal) {
    return { kind: "unsupported" };
  }
  const legacyIdentifiers = visits.filter(({ node, ancestors }) => {
    if (node.type !== "Identifier") {
      return false;
    }
    return (
      (node.name === "tools" || node.name === "ALL_TOOLS") &&
      !isNoncomputedPropertyName(node, ancestors.at(-1))
    );
  });
  if (legacyIdentifiers.length === 0) {
    return { kind: "current" };
  }

  const edits: SourceEdit[] = [];
  const bindings = new Map<string, Identifier>();
  const recognizedTools = new Set<AnyNode>();
  const { codeOffset } = buildCodeModeScriptParseSource(script);

  for (const { node, ancestors } of visits) {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "WithStatement"
    ) {
      return { kind: "unsupported" };
    }
    const legacy = legacyToolCall(node);
    if (!legacy) {
      continue;
    }
    const { call, tool, args } = legacy;
    const parent = ancestors.at(-1);
    const awaited = parent?.type === "AwaitExpression";
    const expression = awaited ? parent : node;
    const owner = ancestors.at(awaited ? -2 : -1);
    const statement = ancestors.at(awaited ? -4 : -3);
    if (owner?.type === "VariableDeclarator") {
      const declaration = ancestors.at(awaited ? -3 : -2);
      if (
        !awaited ||
        declaration?.type !== "VariableDeclaration" ||
        declaration.kind !== "const" ||
        declaration.declarations.length !== 1 ||
        statement !== body ||
        owner.id.type !== "Identifier" ||
        owner.init !== expression ||
        owner.id.name === "exec" ||
        bindings.has(owner.id.name)
      ) {
        return { kind: "unsupported" };
      }
      bindings.set(owner.id.name, owner.id);
    } else if (owner?.type !== "ExpressionStatement" || ancestors.at(awaited ? -3 : -2) !== body) {
      return { kind: "unsupported" };
    }
    recognizedTools.add(tool);
    const removedPrefix = script.slice(call.start - codeOffset, args.start - codeOffset);
    if (sourceContainsComment(removedPrefix)) {
      return { kind: "unsupported" };
    }
    edits.push({
      start: call.start - codeOffset,
      end: args.start - codeOffset,
      replacement: "exec(",
    });
  }

  for (const { node, ancestors } of visits) {
    if (node.type !== "Identifier") {
      continue;
    }
    const parent = ancestors.at(-1);
    if (isNoncomputedPropertyName(node, parent)) {
      continue;
    }
    if (node.name === "tools" || node.name === "ALL_TOOLS") {
      if (!recognizedTools.has(node)) {
        return { kind: "unsupported" };
      }
      continue;
    }
    if (node.name === "exec") {
      if (parent?.type !== "CallExpression" || parent.callee !== node) {
        return { kind: "unsupported" };
      }
      continue;
    }
    const declaration = bindings.get(node.name);
    if (!declaration || declaration === node) {
      continue;
    }
    const details = ancestors.at(-2);
    if (
      !isNamedMember(parent, "result") ||
      parent.object !== node ||
      !isNamedMember(details, "details") ||
      details.object !== parent
    ) {
      return { kind: "unsupported" };
    }
    if (sourceContainsComment(script.slice(node.end - codeOffset, details.end - codeOffset))) {
      return { kind: "unsupported" };
    }
    edits.push({ start: node.end - codeOffset, end: details.end - codeOffset, replacement: "" });
  }

  if (recognizedTools.size !== legacyIdentifiers.length || edits.length === 0) {
    return { kind: "unsupported" };
  }
  let rewritten = script;
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
  }
  const result = migrateLegacyCronTriggerScript(rewritten);
  return result.kind === "current"
    ? { kind: "supported", script: rewritten }
    : { kind: "unsupported" };
}

// The recipe admits native GitHub observations only for an exact script.
const LEGACY_PR_CHECK = SESSION_PR_AUTO_FIX_CHECK.replace("check.state", "trigger.state")
  .replace("result.wake", "result.fire")
  .replace("return { state };", "return { fire: false, state };")
  .replaceAll("finish({})", "finish({ fire: false })")
  .replace("finish({ wake:", "finish({ fire: true, message:");

function rewriteCheckSource(script: string, condition: boolean, main: boolean): string | undefined {
  const parsed = parseCodeModeScriptSyntax(script);
  const wrapper = parsed.ok ? parsed.program.body[0] : undefined;
  if (
    wrapper?.type !== "ExpressionStatement" ||
    wrapper.expression.type !== "ArrowFunctionExpression" ||
    wrapper.expression.body.type !== "BlockStatement"
  ) {
    return undefined;
  }
  const visits = collectSyntaxVisits(wrapper.expression.body);
  const { codeOffset } = buildCodeModeScriptParseSource(script);
  const edits: SourceEdit[] = [];
  for (const { node, ancestors } of visits) {
    const parent = ancestors.at(-1);
    if (node.type === "Identifier" && !isNoncomputedPropertyName(node, parent)) {
      if (
        node.name === "trigger" &&
        parent?.type === "MemberExpression" &&
        parent.object === node &&
        !parent.computed
      ) {
        edits.push({
          start: node.start - codeOffset,
          end: node.end - codeOffset,
          replacement: "check",
        });
      } else if (["trigger", "check", "globalThis", "eval", "Function"].includes(node.name)) {
        return undefined;
      }
      if (node.name === "json" && (parent?.type !== "CallExpression" || parent.callee !== node)) {
        return undefined;
      }
    }
    if (node.type === "ThisExpression") return undefined;
    const isJson =
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "json";
    const isResult =
      node.type === "ReturnStatement" &&
      !ancestors.some(
        (ancestor) =>
          ancestor.type === "FunctionDeclaration" ||
          ancestor.type === "FunctionExpression" ||
          ancestor.type === "ArrowFunctionExpression",
      );
    if (!isJson && !isResult) continue;
    const result = node.type === "CallExpression" ? node.arguments[0] : node.argument;
    if (result?.type !== "ObjectExpression" || (isJson && node.arguments.length !== 1))
      return undefined;
    let fire = false;
    let hasMessage = false;
    for (const prop of result.properties) {
      if (prop.type !== "Property" || prop.computed || prop.kind !== "init" || prop.method)
        return undefined;
      const key =
        prop.key.type === "Identifier"
          ? prop.key.name
          : prop.key.type === "Literal"
            ? prop.key.value
            : undefined;
      if (key === "state") continue;
      if (condition) {
        if (key === "fire" && !fire) fire = true;
        else if (key === "message" && !hasMessage) hasMessage = true;
        else return undefined;
      } else if (key === "notify" && !main) {
        edits.push({
          start: prop.key.start - codeOffset,
          end: prop.key.end - codeOffset,
          replacement: prop.shorthand ? "post: notify" : "post",
        });
      } else if (key !== "nextCheck") {
        // Legacy wake targeted a conversation event, not an agent-turn prompt.
        return undefined;
      }
    }
    if (condition) {
      if (!fire) return undefined;
      edits.push({
        start: result.start - codeOffset,
        end: result.start - codeOffset,
        replacement:
          "((r) => { if (typeof r.fire !== 'boolean' || (r.message !== undefined && typeof r.message !== 'string')) throw new Error('Check requires a boolean fire and optional text'); return { ...(r.fire ? { wake: r.message ?? '' } : {}), ...('state' in r ? { state: r.state } : {}) }; })(",
      });
      edits.push({
        start: result.end - codeOffset,
        end: result.end - codeOffset,
        replacement: ")",
      });
    }
  }
  let rewritten = script;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.replacement + rewritten.slice(edit.end);
  }
  return rewritten.length <= 65_536 && parseCodeModeScriptSyntax(rewritten).ok
    ? rewritten
    : undefined;
}

export function retireCronScriptJob(job: Record<string, unknown>): { paused?: string } | undefined {
  const payload = job.payload as Record<string, unknown> | undefined;
  const condition = Object.hasOwn(job, "trigger");
  const standalone = payload?.kind === "script";
  if (!condition && !standalone) return undefined;
  const trigger =
    typeof job.trigger === "object" && job.trigger !== null
      ? (job.trigger as Record<string, unknown>)
      : undefined;
  const source = condition ? trigger?.script : payload?.script;
  const original = typeof source === "string" ? source : undefined;
  const legacy =
    condition && original !== undefined ? migrateLegacyCronTriggerScript(original) : undefined;
  const code = legacy?.kind === "supported" ? legacy.script : original;
  let paused: string | undefined;
  let script: string | undefined;
  if (job.check !== undefined || (condition && standalone)) {
    paused = "it has more than one script";
  } else if (condition && payload?.kind !== "agentTurn" && payload?.kind !== "accessAgentTurn") {
    paused = "its condition starts a command or system event rather than an agent prompt";
  } else if (code === LEGACY_PR_CHECK && condition) {
    script = SESSION_PR_AUTO_FIX_CHECK;
  } else if (code && legacy?.kind !== "unsupported") {
    script = rewriteCheckSource(code, condition, job.sessionTarget === "main");
  }
  if (!script) {
    paused ??= "Doctor could not preserve its script result or conversation wake behavior";
    job.enabled = false;
    script =
      'throw new Error("This check was paused during migration. Recover the original script from the Doctor backup and edit this check before enabling it.");';
  }
  const bounded = (value: unknown, defaultValue: number, max: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(1, Math.floor(value)))
      : defaultValue;
  job.check = {
    script,
    ...(typeof trigger?.once === "boolean" ? { once: trigger.once } : {}),
    timeoutSeconds: standalone ? bounded(payload?.timeoutSeconds, 300, 900) : 30,
    toolBudget: standalone ? bounded(payload?.toolBudget, 50, 200) : 5,
  };
  if (
    standalone ||
    (paused && payload?.kind !== "agentTurn" && payload?.kind !== "accessAgentTurn")
  ) {
    job.payload = {
      kind: "none",
      toolsAllow: payload?.toolsAllow,
      toolsAllowIsDefault: payload?.toolsAllowIsDefault,
    };
  }
  delete job.trigger;
  return { paused };
}
