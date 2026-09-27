import "./tool-search.js";

type ToolSearchTestApi = {
  maxToolSchemaDirectoryPromptChars: number;
};

function getTestApi(): ToolSearchTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.toolSearchTestApi")
  ] as ToolSearchTestApi;
}

export const testing: ToolSearchTestApi = {
  get maxToolSchemaDirectoryPromptChars() {
    return getTestApi().maxToolSchemaDirectoryPromptChars;
  },
};
