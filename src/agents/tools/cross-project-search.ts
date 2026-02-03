import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const crossProjectSearchSchema = Type.Object({
  project: Type.String({
    description: "Target project ID to search (e.g., 'backend-api', 'frontend')",
    minLength: 1,
  }),
  query: Type.String({
    description: "Search query to find relevant memories in the target project",
    minLength: 1,
  }),
});

export type CrossProjectSearchInput = Static<typeof crossProjectSearchSchema>;

export function validateCrossProjectSearch(input: unknown): {
  valid: boolean;
  data?: CrossProjectSearchInput;
  error?: string;
} {
  try {
    const cleaned = Value.Clean(crossProjectSearchSchema, input);
    const valid = Value.Check(crossProjectSearchSchema, cleaned);
    if (!valid) {
      const errors = [...Value.Errors(crossProjectSearchSchema, cleaned)];
      return { valid: false, error: errors[0]?.message ?? "Invalid input" };
    }
    return { valid: true, data: cleaned as CrossProjectSearchInput };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

export const CROSS_PROJECT_SEARCH_TOOL_NAME = "cross_project_search";

export const crossProjectSearchToolDefinition = {
  name: CROSS_PROJECT_SEARCH_TOOL_NAME,
  description: `Search another project's memory when you need information from a different context.
Only use this when explicitly relevant to the conversation.
Your current project's memory is searched automatically - this tool is for cross-referencing other projects.`,
  input_schema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description: "Target project ID to search",
      },
      query: {
        type: "string",
        description: "Search query",
      },
    },
    required: ["project", "query"],
  },
};
