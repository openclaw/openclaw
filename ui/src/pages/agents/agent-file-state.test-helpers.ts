import type { AgentFilesState } from "./files.ts";

type Editor = AgentFilesState["agentFileEditors"][string];
type FileState = Pick<AgentFilesState, "agentFileEditors">;

export function createAgentFileEditors(fields: {
  content?: Record<string, string>;
  draft?: Record<string, string>;
}): AgentFilesState["agentFileEditors"] {
  const editors: AgentFilesState["agentFileEditors"] = {};
  for (const field of ["content", "draft"] as const) {
    for (const [name, value] of Object.entries(fields[field] ?? {})) {
      editors[name] = { ...editors[name], [field]: value };
    }
  }
  return editors;
}

export function setAgentFileValues<Field extends "content" | "draft" | "version">(
  state: FileState,
  field: Field,
  values: Record<string, Editor[Field]>,
) {
  const names = new Set([...Object.keys(state.agentFileEditors), ...Object.keys(values)]);
  state.agentFileEditors = Object.fromEntries(
    [...names].map((name) => {
      const editor = { ...state.agentFileEditors[name] };
      delete editor[field];
      if (Object.hasOwn(values, name)) {
        editor[field] = values[name];
      }
      return [name, editor];
    }),
  );
}

export function agentFileValues(
  state: FileState,
  field: "content" | "draft",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state.agentFileEditors).flatMap(([name, editor]) =>
      editor[field] === undefined ? [] : [[name, editor[field]]],
    ),
  );
}
