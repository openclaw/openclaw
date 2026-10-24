import { Type, type TSchema } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import { filterProviderNormalizableTools } from "../agents/tool-schema-projection.js";
import { collectPluginLoadHealthFindings } from "../commands/doctor-workspace-status.js";
import { withPluginLoadDiagnostics } from "./load-diagnostics.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { buildPluginInspectReport } from "./status.js";

function createOwner() {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "schema-owner",
    source: "/synthetic/schema-owner.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { tools: ["metadata", "healthy"] },
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record)!;
  onTestFinished(async () => {
    await instance.dispose();
  });
  const resolve = () =>
    instance.wrap(builder.registry.tools[0]!.factory)({ assertInvocationCurrent() {} });
  return { builder, record, api, instance, resolve };
}

function metadataTool(
  parameters: TSchema = Type.Object({ payload: Type.Unsafe({ type: "object" }) }),
) {
  return {
    name: "metadata",
    label: "Metadata",
    description: "Store metadata",
    parameters,
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  };
}

it.each(["static", "factory", "versioned factory"] as const)(
  "warns once for a %s tool through the bound factory without eager factory calls",
  (kind) =>
    withPluginLoadDiagnostics((observed) => {
      const { builder, record, api, resolve } = createOwner();
      let calls = 0;
      const tool = metadataTool();
      const create = () => {
        calls++;
        return tool;
      };
      api.registerTool(
        kind === "static" ? tool : kind === "factory" ? create : { contextVersion: 2, create },
        { name: "metadata" },
      );
      expect(calls).toBe(0);
      expect(
        buildPluginInspectReport({ id: record.id, config: {}, report: builder.registry })
          ?.diagnostics,
      ).toHaveLength(kind === "static" ? 1 : 0);
      expect(resolve()).toMatchObject({ name: "metadata" });
      resolve();
      expect(calls).toBe(kind === "static" ? 0 : 2);
      expect(builder.registry.diagnostics).toEqual([
        expect.objectContaining({
          level: "warn",
          pluginId: record.id,
          message: expect.stringContaining("metadata.parameters.properties.payload"),
        }),
      ]);
      expect(observed).toEqual(builder.registry.diagnostics);
      expect(collectPluginLoadHealthFindings(observed)).toEqual([
        expect.objectContaining({
          severity: "warning",
          target: record.id,
          message: expect.stringContaining("will be closed on strict-compat providers"),
        }),
      ]);
    }),
);

it.each(["static", "factory", "versioned factory"] as const)(
  "keeps unreadable and circular %s schemas registered for per-tool quarantine",
  (kind) => {
    for (const failure of ["getter", "circular", "proxy"] as const) {
      const { builder, api, resolve } = createOwner();
      const circular = Type.Object<Record<string, TSchema>>({});
      circular.properties.self = circular;
      const broken = metadataTool(circular);
      if (failure === "getter") {
        Object.defineProperty(broken, "parameters", {
          get() {
            throw new Error("schema not ready");
          },
        });
      } else if (failure === "proxy") {
        broken.parameters = new Proxy(circular, {
          ownKeys() {
            throw new Error("schema not ready");
          },
        });
      }
      const healthy = { ...metadataTool(Type.Object({ value: Type.String() })), name: "healthy" };
      const create = () => [healthy, broken];
      expect(() =>
        api.registerTool(
          kind === "static" ? broken : kind === "factory" ? create : { contextVersion: 2, create },
          { name: "metadata" },
        ),
      ).not.toThrow();
      expect(builder.registry.tools).toHaveLength(1);
      const result = resolve();
      expect(result).toBeTruthy();
      const tools = Array.isArray(result) ? result : [result!];
      expect(tools.map((tool) => tool.name)).toEqual(
        kind === "static" ? ["metadata"] : ["healthy", "metadata"],
      );
      const projection = filterProviderNormalizableTools(tools);
      expect(projection.tools.map((tool) => tool.name)).toEqual(
        kind === "static" ? [] : ["healthy"],
      );
      expect(projection.diagnostics).toHaveLength(1);
      expect(builder.registry.diagnostics).toEqual([]);
    }
  },
);

it("bounds warning paths and stops inspecting a tool after warning", () => {
  const { builder, api, resolve } = createOwner();
  let reads = 0;
  const tool = {
    ...metadataTool(),
    get parameters() {
      reads++;
      return Type.Object(
        Object.fromEntries(
          Array.from({ length: 15 }, (_, i) => [String(i), Type.Unsafe({ type: "object" })]),
        ),
      );
    },
  };
  api.registerTool(() => tool, { name: "metadata" });
  resolve();
  const afterWarning = reads;
  resolve();
  expect(reads).toBe(afterWarning);
  const message = builder.registry.diagnostics[0]!.message;
  expect(message).toContain("metadata.parameters.properties.11");
  expect(message).not.toContain("metadata.parameters.properties.12");
  expect(message).toContain("+3 more");
});
