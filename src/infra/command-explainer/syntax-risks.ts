import type { Node as TreeSitterNode } from "web-tree-sitter";

export function hasEscapedLineContinuation(text: string): boolean {
  return /\\(?:\r\n|[\r\n])/.test(text);
}

export function hasLineBreakEscapedWordBoundary(text: string): boolean {
  return /(?:\r\n|[\r\n])\\/.test(text);
}

export function hasExecutableLineContinuation(text: string): boolean {
  return /^[^\s]*\\(?:\r\n|[\r\n])/.test(text);
}

// Standalone assignments add no command step, but bash evaluates arithmetic, braced
// expansions, and array subscripts recursively. Preludes and declaration arguments
// are already covered by their command checks.
export function isDynamicStandaloneAssignment(node: TreeSitterNode): boolean {
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
