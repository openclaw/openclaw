/**
 * Tool categorization for experiential significance evaluation.
 *
 * Maps tool names to categories used by the heuristic fallback evaluator
 * to estimate significance without an LLM.
 */

export type ToolCategory = "file" | "message" | "exec" | "browser" | "experience" | "other";

const CATEGORY_MAP: Record<string, ToolCategory> = {
  // File operations
  read_file: "file",
  write_file: "file",
  edit_file: "file",
  create_file: "file",
  delete_file: "file",
  move_file: "file",
  copy_file: "file",
  list_directory: "file",
  search_files: "file",
  glob: "file",
  grep: "file",

  // Message/communication
  send_message: "message",
  reply: "message",
  send_email: "message",
  notify: "message",

  // Execution
  run_command: "exec",
  bash: "exec",
  execute: "exec",
  shell: "exec",

  // Browser
  browse: "browser",
  navigate: "browser",
  screenshot: "browser",
  evaluate_js: "browser",

  // Experience/memory
  remember: "experience",
  recall: "experience",
  memory_store: "experience",
  memory_search: "experience",
};

/** Observation-only tools that should not trigger capture */
const OBSERVATION_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "glob",
  "grep",
  "screenshot",
]);

/** Categorize a tool name into a broad category */
export function categorize(toolName: string): ToolCategory | null {
  const normalized = toolName.toLowerCase().replace(/[-\s]/g, "_");
  return CATEGORY_MAP[normalized] ?? null;
}

/** Check if a tool is observation-only (read, list, snapshot) */
export function isObservation(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[-\s]/g, "_");
  return OBSERVATION_TOOLS.has(normalized);
}

/** Get a base significance multiplier for a tool category */
export function categorySignificanceWeight(category: ToolCategory | null): number {
  switch (category) {
    case "file":
      return 0.6;
    case "message":
      return 0.7;
    case "exec":
      return 0.5;
    case "browser":
      return 0.4;
    case "experience":
      return 0.8;
    case "other":
      return 0.3;
    default:
      return 0.3;
  }
}
