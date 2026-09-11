import { Type } from "typebox";
import { vi } from "vitest";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  type ToolSearchConfig,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

export function fakeTool(name: string, parameters = Type.Object({})): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Run ${name}`,
    parameters,
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ input })),
  };
}

export function createRuntime(tools: AnyAgentTool[]) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  const config = { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never;
  return {
    catalogRef,
    config,
    runtime: new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(config), {
      validateInput: true,
    }),
  };
}

type ToolSearchTestApi = {
  maxToolSchemaDirectoryPromptChars: number;
  setToolSearchCodeModeSupportedForTest(value: boolean | undefined): void;
  setToolSearchMinCodeTimeoutMsForTest(value: number | undefined): void;
  runCodeModeChild(params: {
    code: string;
    config: ToolSearchConfig;
    logs: unknown[];
    parentToolCallId: string;
    runtime: ToolSearchRuntime;
    signal?: AbortSignal;
  }): Promise<unknown>;
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
  setToolSearchCodeModeSupportedForTest: (value) =>
    getTestApi().setToolSearchCodeModeSupportedForTest(value),
  setToolSearchMinCodeTimeoutMsForTest: (value) =>
    getTestApi().setToolSearchMinCodeTimeoutMsForTest(value),
  runCodeModeChild: (params) => getTestApi().runCodeModeChild(params),
};
