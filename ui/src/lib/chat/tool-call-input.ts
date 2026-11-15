import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";

export type ToolCallKind = "command" | "read" | "edit" | "write" | "search" | "fetch" | "generic";

export const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "exec",
  "shell",
  "run_command",
  "run_terminal_cmd",
]);
const TEXT_EDITOR_TOOL_NAMES = new Set(["str_replace_editor", "str_replace_based_edit_tool"]);
export const PATCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "apply_patch",
  "applypatch",
  "patch",
]);
const TOOL_KINDS: ReadonlyArray<readonly [ToolCallKind, ReadonlySet<string>]> = [
  ["command", COMMAND_TOOL_NAMES],
  ["read", new Set(["read", "read_file", "readfile", "notebookread", "notebook_read"])],
  [
    "edit",
    new Set([
      "edit",
      "edit_file",
      "multiedit",
      "multi_edit",
      "notebookedit",
      "notebook_edit",
      ...PATCH_TOOL_NAMES,
    ]),
  ],
  ["write", new Set(["write", "write_file", "create_file"])],
  ["search", new Set(["grep", "find", "glob", "ls", "list", "codebase_search"])],
  ["fetch", new Set(["web_fetch", "webfetch", "fetch"])],
];

function resolveToolCallKind(
  key: string,
  args: Record<string, unknown> | null,
  editorCommand: string | undefined,
): ToolCallKind {
  if (TEXT_EDITOR_TOOL_NAMES.has(key)) {
    switch (editorCommand) {
      case "view":
        return "read";
      case "str_replace":
      case "insert":
      case "undo_edit":
        return "edit";
      case "create":
        return "write";
      default:
        return "generic";
    }
  }
  for (const [kind, names] of TOOL_KINDS) {
    if (names.has(key)) {
      return kind;
    }
  }
  // Arg-shape fallback for harness-specific command tools.
  if (args && typeof args.command === "string" && Object.keys(args).length <= 3) {
    return "command";
  }
  return "generic";
}

/** File identity and tool kind are available before detailed output rendering loads. */
export function resolveToolCallInput(name: string, args: Record<string, unknown> | null) {
  const key = name.trim().toLowerCase();
  const editorCommand = TEXT_EDITOR_TOOL_NAMES.has(key)
    ? readNonBlankString(args?.command)?.trim().toLowerCase()
    : undefined;
  return {
    editorCommand,
    kind: resolveToolCallKind(key, args, editorCommand),
    path:
      readNonBlankString(args?.path) ??
      readNonBlankString(args?.file_path) ??
      readNonBlankString(args?.filePath) ??
      readNonBlankString(args?.file) ??
      readNonBlankString(args?.filepath) ??
      readNonBlankString(args?.filename) ??
      readNonBlankString(args?.notebook_path),
  };
}
