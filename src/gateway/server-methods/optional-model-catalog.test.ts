import { describe, expect, it, vi } from "vitest";
import {
  readPreparedServerMethodModelCatalog,
  readPreparedServerMethodModelCatalogs,
} from "./optional-model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

describe("readPreparedServerMethodModelCatalog", () => {
  it("reads published startup facts without starting catalog discovery", async () => {
    const entries = [{ id: "work-only", name: "Work Model", provider: "work-provider" }];
    const loadGatewayModelCatalog = vi.fn();
    const prepared = { entries };
    const readPreparedGatewayModelCatalog = vi.fn(async () => prepared);
    const context = {
      loadGatewayModelCatalog,
      readPreparedGatewayModelCatalog,
    } as unknown as GatewayRequestContext;

    await expect(readPreparedServerMethodModelCatalog(context, { agentId: "work" })).resolves.toBe(
      prepared,
    );

    expect(readPreparedGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "work" });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });
});

describe("readPreparedServerMethodModelCatalogs", () => {
  it.each(["bulk", "scalar", "unavailable"] as const)(
    "keeps optional catalog failures isolated with a %s context",
    async (mode) => {
      const main = { entries: [{ id: "main", name: "Main", provider: "fixture" }] };
      const work = { entries: [{ id: "work", name: "Work", provider: "fixture" }] };
      const failure = new Error("catalog owner replaced");
      const loadGatewayModelCatalog = vi.fn();
      const context = {
        loadGatewayModelCatalog,
        readPreparedGatewayModelCatalog: async (options?: { agentId?: string }) => {
          if (options?.agentId === "missing") {
            throw failure;
          }
          return options?.agentId === "main" ? main : work;
        },
        ...(mode === "scalar"
          ? {}
          : {
              readPreparedGatewayModelCatalogBatch: async () => {
                if (mode === "unavailable") {
                  throw failure;
                }
                return [
                  { status: "fulfilled" as const, value: work },
                  { status: "rejected" as const, reason: failure },
                  { status: "fulfilled" as const, value: main },
                ];
              },
            }),
      } as unknown as GatewayRequestContext;

      const result = await readPreparedServerMethodModelCatalogs(context, [
        "work",
        "missing",
        "main",
      ]);
      expect([...result]).toEqual([
        ["work", mode === "unavailable" ? undefined : work],
        ["missing", undefined],
        ["main", mode === "unavailable" ? undefined : main],
      ]);
      expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    },
  );
});
