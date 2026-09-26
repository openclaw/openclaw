import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyToolCatalogCompaction, createToolSearchCatalogRef } from "./tool-search-catalog.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("@openclaw/normalization-core/node-crypto", { spy: true });

function tool(name: string, marker = "first") {
  return {
    name,
    label: name,
    description: "Synthetic catalog capability",
    parameters: { type: "object", properties: { value: { type: "string" } } },
    outputSchema: { type: "object", properties: { value: { type: "string" } } },
    execute: vi.fn(async () => ({ content: [], details: { marker } })),
  } satisfies AnyAgentTool;
}

const control = tool("tool_search");
function apply(capability: AnyAgentTool, catalogRef = createToolSearchCatalogRef()) {
  return applyToolCatalogCompaction({
    tools: [control, capability],
    enabled: true,
    catalogRef,
    isVisibleControlTool: (candidate) => candidate.name === control.name,
  });
}

describe("catalog fingerprint reuse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reuses descriptor hashes across requests while binding the current executor and lifetime", async () => {
    const firstRef = createToolSearchCatalogRef();
    const first = tool("fingerprint-current-executor");
    apply(first, firstRef);
    const secondRef = createToolSearchCatalogRef();
    const second = tool(first.name, "second");
    expect(apply(second, secondRef).catalogReused).toBe(false);
    expect(sha256StableValue).toHaveBeenCalledTimes(1);
    expect(secondRef.current?.counterScope).not.toBe(firstRef.current?.counterScope);
    expect(apply(second, secondRef).catalogReused).toBe(true);
    await expect(secondRef.current?.entries[0]?.tool.execute("call", {})).resolves.toMatchObject({
      details: { marker: "second" },
    });
    expect(first.execute).not.toHaveBeenCalled();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(sha256StableValue).toHaveBeenCalledTimes(1);
  });

  it.each(["parameters", "outputSchema"] as const)(
    "invalidates in-place nested %s edits after warming the fingerprint",
    (field) => {
      const catalogRef = createToolSearchCatalogRef();
      const capability = tool(`fingerprint-mutation-${field}`);
      apply(capability, catalogRef);
      expect(apply(capability, catalogRef).catalogReused).toBe(true);
      const before = catalogRef.current;
      capability[field].properties.value.type = "number";
      expect(apply(capability, catalogRef).catalogReused).toBe(false);
      expect(catalogRef.current).not.toBe(before);
      expect(catalogRef.current?.entries[0]?.[field]).toMatchObject({
        properties: { value: { type: "number" } },
      });
      expect(sha256StableValue).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves the streaming fingerprint path for getters, proxies, and oversized schemas", () => {
    const readValue = vi.fn(() => "string");
    const ownKeys = vi.fn(Reflect.ownKeys);
    const schemas = [
      {
        type: "object",
        properties: {
          value: {
            get type() {
              return readValue();
            },
          },
        },
      },
      new Proxy({ type: "object", properties: {} }, { ownKeys }),
      { type: "object", description: "x".repeat(64 * 1024) },
    ];
    for (const [index, parameters] of schemas.entries()) {
      const capability: AnyAgentTool = { ...tool(`fingerprint-uncached-${index}`), parameters };
      const catalogRef: ToolSearchCatalogRef = createToolSearchCatalogRef();
      apply(capability, catalogRef);
      expect(apply(capability, catalogRef).catalogReused).toBe(true);
    }
    expect(readValue).toHaveBeenCalledTimes(2);
    expect(ownKeys).toHaveBeenCalledTimes(2);
    expect(sha256StableValue).toHaveBeenCalledTimes(6);
  });
});
