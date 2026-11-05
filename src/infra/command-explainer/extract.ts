import type { Node as TreeSitterNode } from "web-tree-sitter";
import {
  detectCarriedShellBuiltinArgv,
  detectCarrierInlineEvalArgv as detectSharedCarrierInlineEvalArgv,
  detectCommandCarrierArgv,
  detectInlineEvalArgv,
  detectShellWrapperThroughCarrierArgv,
} from "../command-analysis/risks.js";
import { SOURCE_EXECUTABLES } from "../command-carriers.js";
import { normalizeExecutableToken } from "../exec-wrapper-resolution.js";
import {
  extractShellWrapperCommand,
  extractShellWrapperInlineCommand,
  isShellWrapperExecutable,
  POSIX_PARSEABLE_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "../shell-wrapper-resolution.js";
import {
  decodeShellText,
  hasEscapedLineContinuation,
  hasUnescapedDynamicPattern,
} from "./shell-text.js";
import {
  resolveCommandOperators,
  type CommandOperatorSource,
  type RecordedCommandStep,
} from "./topology.js";
import {
  getBashParserForCommandExplanation,
  type BashCommandParser,
} from "./tree-sitter-runtime.js";
import type {
  CommandContext,
  CommandExplanation,
  CommandRisk,
  CommandShape,
  SourceSpan,
} from "./types.js";

type MutableExplanation = {
  shapes: Set<CommandShape>;
  commands: RecordedCommandStep[];
  operatorSources: CommandOperatorSource[];
  risks: CommandRisk[];
  hasParseError: boolean;
  remainingNodes: number;
};

type CommandArgument = {
  text: string;
  value: string;
  span: SourceSpan;
  node: TreeSitterNode;
};

type CommandArgv = {
  argv: string[];
  arguments: CommandArgument[];
  dynamicArguments: CommandArgument[];
};

type WalkState = {
  parse: BashCommandParser;
  wrapperPayloadDepth: number;
  spanBase: SpanBase;
  parentCommandId?: string;
};

type WalkFrame = {
  node: TreeSitterNode;
  context: CommandContext;
  state: WalkState;
};

const MAX_WRAPPER_PAYLOAD_DEPTH = 2;
// Wrapper payload reparses share this budget, so one explanation has one fixed work bound.
const MAX_COMMAND_EXPLANATION_NODES = 50_000;

export class CommandExplanationWorkLimitError extends Error {}

// Span bases map nested wrapper payload offsets back to source command offsets.
type SpanBase = {
  mapOffset?: (offset: number) => { index: number; position: SourceSpan["startPosition"] };
};

const ROOT_SPAN_BASE: SpanBase = {};

function hasDirectChildType(node: TreeSitterNode, type: string): boolean {
  return node.children.some((child) => child.type === type);
}

function translateSpan(span: SourceSpan, base: SpanBase): SourceSpan {
  if (!base.mapOffset) {
    return span;
  }
  const start = base.mapOffset(span.startIndex);
  const end = base.mapOffset(span.endIndex);
  return {
    startIndex: start.index,
    endIndex: end.index,
    startPosition: start.position,
    endPosition: end.position,
  };
}

function spanFromNode(node: TreeSitterNode, base: SpanBase = ROOT_SPAN_BASE): SourceSpan {
  const { startIndex, endIndex, startPosition, endPosition } = node;
  return translateSpan({ startIndex, endIndex, startPosition, endPosition }, base);
}

function advancePosition(
  position: SourceSpan["startPosition"],
  text: string,
): SourceSpan["startPosition"] {
  let row = position.row;
  let column = position.column;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row += 1;
      column = 0;
      continue;
    }
    column += 1;
  }
  return { row, column };
}

function decodedSourceOffsetsForNode(node: TreeSitterNode, value: string): number[] {
  const prefixLength =
    node.type === "string" || node.type === "raw_string"
      ? 1
      : node.type === "ansi_c_string"
        ? 2
        : 0;
  if (node.type !== "raw_string") {
    const sourceOffsets: number[] = [];
    const quoting =
      node.type === "string" ? "double" : node.type === "ansi_c_string" ? "ansi-c" : "unquoted";
    const decoded = decodeShellText(node.text, quoting, sourceOffsets);
    if (decoded === value && sourceOffsets.length === value.length + 1) {
      return sourceOffsets;
    }
  }
  return Array.from({ length: value.length + 1 }, (_, index) => prefixLength + index);
}

type ShellWordValue = { kind: "literal"; value: string } | { kind: "dynamic"; value: string };

const DYNAMIC_WORD_NODE_TYPES = new Set([
  "arithmetic_expansion",
  "command_substitution",
  "expansion",
  "process_substitution",
  "simple_expansion",
]);

const COMMAND_ARGUMENT_NODE_TYPES = new Set([
  "ansi_c_string",
  "arithmetic_expansion",
  "command_substitution",
  "concatenation",
  "expansion",
  "number",
  "process_substitution",
  "raw_string",
  "simple_expansion",
  "string",
  "word",
]);

function hasDynamicWordPart(root: TreeSitterNode): boolean {
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (DYNAMIC_WORD_NODE_TYPES.has(node.type)) {
      return true;
    }
    for (const child of node.namedChildren) {
      pending.push(child);
    }
  }
  return false;
}

function shellWordValue(node: TreeSitterNode): ShellWordValue {
  if (DYNAMIC_WORD_NODE_TYPES.has(node.type)) {
    return { kind: "dynamic", value: node.text };
  }
  if (
    node.type !== "command_name" &&
    node.type !== "concatenation" &&
    node.namedChildren.some((child) => hasDynamicWordPart(child))
  ) {
    return {
      kind: "dynamic",
      value: node.type === "string" ? decodeShellText(node.text, "double") : node.text,
    };
  }

  switch (node.type) {
    case "command_name":
    case "concatenation": {
      const parts = node.namedChildren;
      if (
        node.type === "command_name" ? parts.length === 0 : hasUnescapedDynamicPattern(node.text)
      ) {
        return {
          kind: hasUnescapedDynamicPattern(node.text) ? "dynamic" : "literal",
          value: decodeShellText(node.text),
        };
      }
      let value = "";
      let dynamic = false;
      for (const part of parts) {
        const partValue = shellWordValue(part);
        value += partValue.value;
        if (partValue.kind !== "literal") {
          dynamic = true;
          if (node.type === "command_name") {
            break;
          }
        }
      }
      return { kind: dynamic ? "dynamic" : "literal", value };
    }
    case "word":
      return {
        kind: hasUnescapedDynamicPattern(node.text) ? "dynamic" : "literal",
        value: decodeShellText(node.text),
      };
    case "raw_string":
      return { kind: "literal", value: node.text.slice(1, -1) };
    case "string":
      return { kind: "literal", value: decodeShellText(node.text, "double") };
    case "ansi_c_string":
      return { kind: "literal", value: decodeShellText(node.text, "ansi-c") };
    default:
      return {
        kind: node.namedChildren.some((child) => shellWordValue(child).kind === "dynamic")
          ? "dynamic"
          : "literal",
        value: decodeShellText(node.text),
      };
  }
}

function appendCommandArgument(node: TreeSitterNode, parsed: CommandArgv, state: WalkState): void {
  const value = shellWordValue(node);
  const argument: CommandArgument = {
    text: node.text,
    value: value.value,
    span: spanFromNode(node, state.spanBase),
    node,
  };
  parsed.arguments.push(argument);
  if (value.kind === "dynamic") {
    parsed.dynamicArguments.push(argument);
  }
  parsed.argv.push(value.value);
}

function argvFromCommand(
  node: TreeSitterNode,
  nameNode: TreeSitterNode | null,
  state: WalkState,
): CommandArgv | null {
  let executable: string;
  if (node.type === "command") {
    if (
      !nameNode ||
      hasEscapedLineContinuation(nameNode.text) ||
      /^[^\s]*\\(?:\r\n|[\r\n])/.test(node.text)
    ) {
      return null;
    }
    const value = shellWordValue(nameNode);
    if (value.kind !== "literal") {
      return null;
    }
    executable = value.value;
  } else if (node.type === "declaration_command") {
    executable = node.text.trimStart().match(/^\S+/)?.[0] ?? "";
  } else {
    const trimmed = node.text.trimStart();
    executable = trimmed.startsWith("[[") ? "[[" : trimmed.startsWith("[") ? "[" : "";
  }
  if (node.type !== "command" && !executable) {
    return null;
  }
  const parsed: CommandArgv = { argv: [executable], arguments: [], dynamicArguments: [] };
  const children =
    node.type === "command" ? node.childrenForFieldName("argument") : node.namedChildren;
  for (const child of children) {
    if (node.type === "test_command") {
      appendTestCommandArguments(child, parsed, state);
    } else if (
      COMMAND_ARGUMENT_NODE_TYPES.has(child.type) ||
      (node.type === "declaration_command" && child.type === "variable_assignment")
    ) {
      appendCommandArgument(child, parsed, state);
    }
  }
  return parsed;
}

function appendTestCommandArguments(
  root: TreeSitterNode,
  parsed: CommandArgv,
  state: WalkState,
): void {
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.type === "test_operator" || COMMAND_ARGUMENT_NODE_TYPES.has(node.type)) {
      appendCommandArgument(node, parsed, state);
      continue;
    }
    for (let index = node.namedChildren.length - 1; index >= 0; index -= 1) {
      const child = node.namedChildren[index];
      if (child) {
        pending.push(child);
      }
    }
  }
}

function isCommandLikeNode(node: TreeSitterNode): boolean {
  return (
    node.type === "command" || node.type === "declaration_command" || node.type === "test_command"
  );
}

// A standalone assignment adds no command step, but bash evaluates `$((name))`, `${name:expr}`,
// `${arr[expr]}`, `${!name}`, `${name@P}` and `name[expr]=` recursively, and an array subscript
// reached that way runs command substitutions. Command preludes and declaration arguments are
// already covered by the prelude and dynamic-argument checks.
function isDynamicStandaloneAssignment(node: TreeSitterNode): boolean {
  if (node.type !== "variable_assignment") {
    return false;
  }
  const parentType = node.parent?.type;
  if (parentType === "command" || parentType === "declaration_command") {
    return false;
  }
  // The parser flattens keyed compound entries, whose semantics depend on prior array state.
  const value = node.childForFieldName("value");
  return (
    node.childForFieldName("name")?.type === "subscript" ||
    (value?.type === "array" &&
      value.namedChildren.some((entry) => /^\s*\[[\s\S]*\]\+?=/u.test(entry.text))) ||
    node.descendantsOfType(["arithmetic_expansion", "expansion"]).length > 0
  );
}

function recordShape(node: TreeSitterNode, output: MutableExplanation): void {
  if (
    (node.type === "program" || node.type === "list") &&
    (hasDirectChildType(node, ";") || node.namedChildren.filter(isCommandLikeNode).length > 1)
  ) {
    output.shapes.add("sequence");
  }
  if (hasDirectChildType(node, "&")) {
    output.shapes.add("background");
  }
  if (node.type === "list") {
    if (hasDirectChildType(node, "&&")) {
      output.shapes.add("and");
    }
    if (hasDirectChildType(node, "||")) {
      output.shapes.add("or");
    }
  }
  const shape = STATEMENT_SHAPES.get(node.type);
  if (shape) {
    output.shapes.add(shape);
  }
}

const STATEMENT_SHAPES = new Map<string, CommandShape>([
  ["pipeline", "pipeline"],
  ["if_statement", "if"],
  ["for_statement", "for"],
  ["while_statement", "while"],
  ["case_statement", "case"],
  ["subshell", "subshell"],
  ["compound_statement", "group"],
]);

function shellCommandFlag(
  argv: string[],
  startIndex: number,
): { flag: string; index: number } | null {
  const shell = normalizeExecutableToken(argv[startIndex - 1] ?? argv[0] ?? "");
  const isPosix = shell !== "cmd" && shell !== "powershell" && shell !== "pwsh";
  const flags =
    shell === "cmd"
      ? ["/c", "/k"]
      : isPosix
        ? ["-c", "--command"]
        : ["-c", "-command", "--command", "-encodedcommand", "-enc", "-e", "-f", "-file"];
  for (let index = startIndex; index < argv.length; index += 1) {
    const token = argv[index]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--") {
      break;
    }
    const lower = token.toLowerCase();
    if (
      flags.includes(lower) ||
      (isPosix && token.startsWith("-") && !token.startsWith("--") && lower.slice(1).includes("c"))
    ) {
      return { flag: token, index };
    }
  }
  return null;
}

function canParseShellWrapperPayload(transportArgv: string[], commandFlag: string | null): boolean {
  const shellExecutable = normalizeExecutableToken(transportArgv[0] ?? "");
  if (!POSIX_PARSEABLE_SHELL_WRAPPERS.has(shellExecutable)) {
    return false;
  }
  const lowerFlag = commandFlag?.toLowerCase() ?? "";
  return lowerFlag === "-c" || lowerFlag === "--command" || /^-[^-]*c[^-]*$/i.test(lowerFlag);
}

function payloadBaseFromArgument(argument: CommandArgument, payload: string): SpanBase | null {
  const payloadOffset = argument.value.indexOf(payload);
  if (payloadOffset < 0) {
    return null;
  }
  // Trees remain alive for the synchronous walk; only wrapper payloads need offset maps.
  const sourceOffsets = decodedSourceOffsetsForNode(argument.node, argument.value);
  const rawPayloadOffset = sourceOffsets[payloadOffset];
  if (rawPayloadOffset === undefined) {
    return null;
  }
  return {
    mapOffset(offset) {
      const rawOffset = sourceOffsets[payloadOffset + offset];
      const mappedRawOffset = rawOffset ?? rawPayloadOffset + offset;
      return {
        index: argument.span.startIndex + mappedRawOffset,
        position: advancePosition(
          argument.span.startPosition,
          argument.text.slice(0, mappedRawOffset),
        ),
      };
    },
  };
}

function payloadBaseFromArguments(
  payload: string,
  argumentsList: CommandArgument[],
): SpanBase | null {
  const exactArgument = argumentsList.find((argument) => argument.value === payload);
  if (exactArgument) {
    return payloadBaseFromArgument(exactArgument, payload);
  }
  for (const argument of argumentsList) {
    const base = payloadBaseFromArgument(argument, payload);
    if (base) {
      return base;
    }
  }
  return null;
}

function recordCommandRisks(
  parsed: CommandArgv,
  span: SourceSpan,
  output: MutableExplanation,
): { command: string; spanBase: SpanBase } | null {
  const { argv, dynamicArguments } = parsed;
  const executable = argv[0];
  if (!executable) {
    return null;
  }
  const normalizedExecutable = normalizeExecutableToken(executable);
  for (const argument of dynamicArguments) {
    output.risks.push({
      kind: "dynamic-argument",
      command: normalizedExecutable,
      text: argument.text,
      span: argument.span,
    });
  }
  const inlineEval = detectInlineEvalArgv(argv) ?? detectSharedCarrierInlineEvalArgv(argv);
  if (inlineEval) {
    output.risks.push({
      kind: "inline-eval",
      command: inlineEval.normalizedExecutable,
      flag: inlineEval.flag,
      span,
    });
  }

  const shellWrapper = extractShellWrapperCommand(argv);
  const shellWrapperPayload = shellWrapper.command ?? extractShellWrapperInlineCommand(argv);
  let wrapperPayload: { command: string; spanBase: SpanBase } | null = null;
  if (shellWrapper.isWrapper && shellWrapperPayload) {
    const transportArgv = resolveShellWrapperTransportArgv(argv) ?? argv;
    const shellExecutable = transportArgv[0] ?? executable;
    const commandFlag = shellCommandFlag(transportArgv, 1) ?? shellCommandFlag(argv, 1);
    if (
      !dynamicArguments.some((argument) => argument.value === shellWrapperPayload) &&
      canParseShellWrapperPayload(transportArgv, commandFlag?.flag ?? null)
    ) {
      const spanBase = payloadBaseFromArguments(shellWrapperPayload, parsed.arguments);
      if (spanBase) {
        wrapperPayload = { command: shellWrapperPayload, spanBase };
      }
    }
    if (isShellWrapperExecutable(executable)) {
      output.risks.push({
        kind: "shell-wrapper",
        executable: shellExecutable,
        flag: commandFlag?.flag ?? "-c",
        payload: shellWrapperPayload,
        span,
      });
    } else {
      output.risks.push({
        kind: "shell-wrapper-through-carrier",
        span,
      });
    }
  }

  for (const carrier of detectCommandCarrierArgv(argv)) {
    output.risks.push({
      kind: "command-carrier",
      command: carrier.command,
      flag: carrier.flag,
      span,
    });
  }
  if (normalizedExecutable === "eval") {
    output.risks.push({ kind: "eval", span });
  }
  if (SOURCE_EXECUTABLES.has(normalizedExecutable)) {
    output.risks.push({ kind: "source", command: normalizedExecutable, span });
  }
  if (normalizedExecutable === "alias") {
    output.risks.push({ kind: "alias", span });
  }
  const carrierShellWrapper = !shellWrapper.isWrapper
    ? detectShellWrapperThroughCarrierArgv(argv, shellCommandFlag)
    : null;
  if (carrierShellWrapper) {
    output.risks.push({
      kind: "shell-wrapper-through-carrier",
      span,
    });
  }

  const carriedShellBuiltin = detectCarriedShellBuiltinArgv(argv);
  if (carriedShellBuiltin?.kind === "eval") {
    output.risks.push({ kind: "eval", span });
  } else if (carriedShellBuiltin?.kind === "source") {
    output.risks.push({
      kind: "source",
      command: carriedShellBuiltin.command,
      span,
    });
  }
  return wrapperPayload;
}

function visitNode(
  node: TreeSitterNode,
  output: MutableExplanation,
  context: CommandContext,
  state: WalkState,
): CommandContext {
  recordShape(node, output);

  const span = spanFromNode(node, state.spanBase);
  let childContext = context;
  if (node.type === "program" && hasEscapedLineContinuation(node.text)) {
    output.risks.push({ kind: "line-continuation", span });
  } else if (node.type === "word" && /(?:\r\n|[\r\n])\\/.test(node.text)) {
    output.risks.push({ kind: "line-continuation", span });
  }

  if (node.type === "function_definition") {
    const nameNode = node.childForFieldName("name");
    output.risks.push({
      kind: "function-definition",
      name: nameNode?.text ?? "",
      span,
    });
    childContext = "function-definition";
  } else if (node.type === "command_substitution") {
    output.risks.push({ kind: "command-substitution", span });
    childContext = "command-substitution";
  } else if (node.type === "process_substitution") {
    output.risks.push({ kind: "process-substitution", span });
    childContext = "process-substitution";
  } else if (node.type === "heredoc_redirect") {
    output.risks.push({ kind: "heredoc", span });
  } else if (node.type === "herestring_redirect") {
    output.risks.push({ kind: "here-string", span });
  } else if (node.type === "file_redirect") {
    output.risks.push({ kind: "redirect", span });
  } else if (node.type === "ERROR") {
    output.risks.push({ kind: "syntax-error", span });
  } else if (isDynamicStandaloneAssignment(node)) {
    output.risks.push({ kind: "dynamic-assignment", span });
  }

  if (isCommandLikeNode(node)) {
    const nameNode = node.type === "command" ? node.childForFieldName("name") : null;
    const parsed = argvFromCommand(node, nameNode, state);
    if (node.type === "command" && nameNode && !parsed) {
      output.risks.push({
        kind: "dynamic-executable",
        span: spanFromNode(nameNode, state.spanBase),
      });
    } else if (parsed) {
      const commandId = `command-${output.commands.length}`;
      const step: RecordedCommandStep = {
        id: commandId,
        context,
        executable: parsed.argv[0] ?? "",
        argv: parsed.argv,
        text: node.text,
        span,
        executableSpan:
          nameNode !== null
            ? spanFromNode(nameNode, state.spanBase)
            : (parsed.arguments[0]?.span ?? span),
      };
      if (nameNode) {
        step.argvSpans = [
          step.executableSpan,
          ...parsed.arguments.map((argument) => argument.span),
        ];
      }
      if (state.parentCommandId) {
        step.parentCommandId = state.parentCommandId;
      }
      if (step.executable) {
        output.commands.push(step);
        const wrapperPayload = recordCommandRisks(parsed, span, output);
        if (wrapperPayload && state.wrapperPayloadDepth < MAX_WRAPPER_PAYLOAD_DEPTH) {
          const wrapperTree = state.parse(wrapperPayload.command);
          const wrapperSpanBase = wrapperPayload.spanBase;
          try {
            output.operatorSources.push({
              context: "wrapper-payload",
              parentCommandId: commandId,
              source: wrapperPayload.command,
            });
            if (wrapperTree.rootNode.hasError) {
              output.hasParseError = true;
              output.risks.push({
                kind: "syntax-error",
                span: spanFromNode(wrapperTree.rootNode, wrapperSpanBase),
              });
            }
            walk(wrapperTree.rootNode, output, "wrapper-payload", {
              parse: state.parse,
              wrapperPayloadDepth: state.wrapperPayloadDepth + 1,
              spanBase: wrapperSpanBase,
              parentCommandId: commandId,
            });
          } finally {
            wrapperTree.delete();
          }
        }
      }
    }
  }
  return childContext;
}

function walk(
  root: TreeSitterNode,
  output: MutableExplanation,
  rootContext: CommandContext,
  rootState: WalkState,
): void {
  if (root.descendantCount > output.remainingNodes) {
    throw new CommandExplanationWorkLimitError(
      "Shell command syntax is too complex to explain safely",
    );
  }
  output.remainingNodes -= root.descendantCount;

  // Shell syntax is model-controlled, so keep depth-first traversal off the call stack.
  const pending: WalkFrame[] = [{ node: root, context: rootContext, state: rootState }];
  for (let frame = pending.pop(); frame; frame = pending.pop()) {
    const { node, context, state } = frame;
    const childContext = visitNode(node, output, context, state);
    for (let index = node.namedChildren.length - 1; index >= 0; index -= 1) {
      const child = node.namedChildren[index];
      if (child) {
        pending.push({ node: child, context: childContext, state });
      }
    }
  }
}

export async function explainShellCommand(source: string): Promise<CommandExplanation> {
  // Finish and delete each tree without yielding: overlapping walks grow the WASM high-water mark.
  const parse = await getBashParserForCommandExplanation();
  const tree = parse(source);
  try {
    const output: MutableExplanation = {
      shapes: new Set(),
      commands: [],
      operatorSources: [],
      risks: [],
      hasParseError: tree.rootNode.hasError,
      remainingNodes: MAX_COMMAND_EXPLANATION_NODES,
    };
    walk(tree.rootNode, output, "top-level", {
      parse,
      wrapperPayloadDepth: 0,
      spanBase: ROOT_SPAN_BASE,
    });
    const topLevelCommands = output.commands.filter((command) => command.context === "top-level");
    const operators = resolveCommandOperators(source, output.commands, output.operatorSources);
    return {
      ok: !output.hasParseError,
      shapes: [...output.shapes],
      topLevelCommands,
      nestedCommands: output.commands.filter((command) => command.context !== "top-level"),
      operators,
      risks: output.risks,
    };
  } finally {
    tree.delete();
  }
}
