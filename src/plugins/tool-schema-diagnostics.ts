import { findCompatClosedObjectPaths } from "@openclaw/ai/internal/tool-schema";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ProviderToolSchemaDiagnostic } from "./provider-replay.types.js";

// Admitted tool schemas are immutable. Share registration scans by schema identity,
// but keep tool names/indices out of the cache.
const schemaPaths = new WeakMap<object, string[]>();

/** Best-effort warnings; runtime projection owns unreadable/non-serializable schemas. */
export function inspectOpenDictionaryToolSchemas(
  tools: readonly Pick<AnyAgentTool, "name" | "parameters">[],
  warnedTools?: ReadonlySet<string>,
): ProviderToolSchemaDiagnostic[] {
  return tools.flatMap((tool, toolIndex) => {
    try {
      const toolName = tool.name;
      if (warnedTools?.has(toolName)) {
        return [];
      }
      const parameters = tool.parameters;
      if (!parameters || typeof parameters !== "object") {
        return [];
      }
      let paths = schemaPaths.get(parameters);
      if (!paths) {
        paths = findCompatClosedObjectPaths(parameters, "");
        schemaPaths.set(parameters, paths);
      }
      const violations = paths.map((path) => `${toolName}.parameters${path}`);
      return violations.length ? [{ toolName, toolIndex, violations }] : [];
    } catch {
      // Do not let one malformed tool reject registration or its factory siblings.
      return [];
    }
  });
}
