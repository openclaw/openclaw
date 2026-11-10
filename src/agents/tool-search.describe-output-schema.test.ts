import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { fakeTool } from "./test-helpers/fake-tool.js";
import {
  applyToolSchemaDirectoryCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AgentToolResult, type AnyAgentTool } from "./tools/common.js";

const option = "includeRarelyNeededOutputSchema";
const controlNames = [
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
];
const contexts: { catalogRef: ReturnType<typeof createToolSearchCatalogRef> }[] = [];

afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    clearToolSearchCatalog(ctx);
  }
});

function modelText(result: AgentToolResult<unknown>): string {
  return (result.content[0] as { type: "text"; text: string }).text;
}

it("sends output schemas through tool_describe only on explicit request", async () => {
  const target = fakeTool("orchard_ledger", "Read the orchard ledger");
  setPluginToolMeta(target, { pluginId: "fake-catalog", optional: true });
  target.outputSchema = Type.Object(
    { entries: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: false })) },
    { additionalProperties: false },
  );
  target.execute = vi.fn(async () => jsonResult({ entries: [{ id: "L-1" }] }));
  const ctx = {
    config: { tools: { toolSearch: { enabled: true, mode: "directory" as const } } },
    catalogRef: createToolSearchCatalogRef(),
  };
  contexts.push(ctx);
  const compacted = applyToolSchemaDirectoryCatalog({
    ...ctx,
    tools: [...controlNames.map((name) => fakeTool(name, name)), target],
  });
  const controls = createToolSearchTools(ctx);
  const control = (name: string) =>
    expectDefined(
      controls.find((tool) => tool.name === name),
      name,
    );
  const describeTool = control(TOOL_DESCRIBE_RAW_TOOL_NAME);

  const searchText = modelText(
    await control(TOOL_SEARCH_RAW_TOOL_NAME).execute("search", { query: "orchard ledger" }),
  );
  expect(searchText).toContain('"output":');
  expect(
    (describeTool.parameters as { properties: Record<string, { description?: string }> })
      .properties[option]?.description,
  ).toMatch(/^Rarely needed;.*tens of thousands of characters.*before calling/);
  for (const text of [
    searchText,
    ...[...compacted.tools, ...controls].map((tool) => tool.description),
    JSON.stringify(controls.filter((tool) => tool !== describeTool).map((tool) => tool.parameters)),
  ]) {
    expect(text).not.toContain(option);
  }

  const described = await describeTool.execute("describe", { id: "orchard_ledger" });
  const defaultText = modelText(described);
  expect(JSON.parse(defaultText)).toMatchObject({
    name: "orchard_ledger",
    output: "{ entries: Array<{ id: string }> }",
    parameters: { type: "object" },
  });
  expect(defaultText).not.toContain("outputSchema");
  expect(defaultText).toBe(JSON.stringify(JSON.parse(defaultText)));
  expect(described.details).toMatchObject({ outputSchema: target.outputSchema });

  const requested = await describeTool.execute("describe-schema", {
    id: "orchard_ledger",
    [option]: true,
  });
  expect(JSON.parse(modelText(requested)).outputSchema).toEqual(
    JSON.parse(JSON.stringify(target.outputSchema)),
  );

  await expect(
    control(TOOL_CALL_RAW_TOOL_NAME).execute("call", { id: "orchard_ledger" }),
  ).resolves.toMatchObject({ details: { result: { details: { entries: [{ id: "L-1" }] } } } });
});
