import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import { createToolSearchTools, resolveToolSearchConfig } from "./tool-search.js";
import { textResult, type AnyAgentTool } from "./tools/common.js";

it("offers exact schema recovery when a wide input hint elides nested fields", async () => {
  const execute = vi.fn(async () => textResult("ran", {}));
  const tool: AnyAgentTool = {
    name: "wide_search",
    label: "Wide search",
    description: "Inspect the archive",
    execute,
    parameters: {},
  };
  tool.parameters = Type.Object(
    {
      target: Type.String(),
      ...Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => [`option${index}`, Type.Optional(Type.String())]),
      ),
      filters: Type.Optional(
        Type.Object(
          { region: Type.String(), pageSize: Type.Integer() },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  );
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool] });
  const config = { tools: { toolSearch: true } };
  const controls = createToolSearchTools({ config, catalogRef });
  const dispatch = (id: string, args: unknown) =>
    expectDefined(
      controls.find((control) => control.name === "dispatch_action"),
      "dispatch_action",
    ).execute("dispatch", { id, args });
  const id = "openclaw:core:wide_search";
  const runtime = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(config), {
    validateInput: true,
  });
  await expect(
    runtime.callExactValue(
      id,
      { target: "archive", filters: { unrelated: true } },
      { recoverySurface: "catalog" },
    ),
  ).rejects.toThrow("tool handle's describe()");
  await expect(dispatch(id, { target: "archive", filters: { unrelated: true } })).rejects.toThrow(
    `Use tool_describe with id "${id}"`,
  );
  expect(tool.execute).not.toHaveBeenCalled();
  expect((await runtime.describe(id)).parameters).toMatchObject({
    properties: { filters: { properties: { pageSize: { type: "integer" } } } },
  });
  await dispatch(id, { target: "archive", filters: { region: "local", pageSize: 2 } });
  expect(tool.execute).toHaveBeenCalledOnce();
});
