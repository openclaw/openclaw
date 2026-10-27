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
  onTestFinished(() => instance.dispose().then(() => undefined));
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
  "publishes one warning when a %s tool becomes available",
  (kind) =>
    withPluginLoadDiagnostics((observed) => {
      const { builder, record, api, resolve } = createOwner();
      const tool = metadataTool();
      const create = () => tool;
      api.registerTool(
        kind === "static" ? tool : kind === "factory" ? create : { contextVersion: 2, create },
        { name: "metadata" },
      );
      expect(
        buildPluginInspectReport({ id: record.id, config: {}, report: builder.registry })
          ?.diagnostics,
      ).toHaveLength(kind === "static" ? 1 : 0);
      expect(resolve()).toMatchObject({ name: "metadata" });
      resolve();
      expect(builder.registry.diagnostics).toMatchObject([
        {
          level: "warn",
          pluginId: record.id,
          message: expect.stringContaining("metadata.parameters.properties.payload"),
        },
      ]);
      expect(observed).toEqual(builder.registry.diagnostics);
      expect(collectPluginLoadHealthFindings(observed)).toMatchObject([
        {
          severity: "warning",
          target: record.id,
        },
      ]);
    }),
);

it.each([
  ["static", "getter"],
  ["factory", "circular"],
  ["versioned factory", "proxy"],
] as const)(
  "keeps %s tools with %s schemas registered for per-tool quarantine",
  (kind, failure) => {
    const { builder, api, resolve } = createOwner();
    const circular = Type.Object<Record<string, TSchema>>({});
    circular.properties.self = circular;
    const broken = metadataTool(circular);
    const unreadable = () => {
      throw new Error("schema not ready");
    };
    if (failure === "getter") {
      Object.defineProperty(broken, "parameters", { get: unreadable });
    } else if (failure === "proxy") {
      broken.parameters = new Proxy(circular, { ownKeys: unreadable });
    }
    const healthy = { ...metadataTool(Type.Object({ value: Type.String() })), name: "healthy" };
    const create = () => [healthy, broken];
    api.registerTool(
      kind === "static" ? broken : kind === "factory" ? create : { contextVersion: 2, create },
      { name: "metadata" },
    );
    const result = resolve();
    const tools = Array.isArray(result) ? result : [result!];
    expect(tools.map((tool) => tool.name)).toEqual(
      kind === "static" ? ["metadata"] : ["healthy", "metadata"],
    );
    const projection = filterProviderNormalizableTools(tools);
    expect(projection.tools.map((tool) => tool.name)).toEqual(kind === "static" ? [] : ["healthy"]);
    expect(projection.diagnostics).toHaveLength(1);
    expect(builder.registry.diagnostics).toEqual([]);
  },
);

it("bounds warning paths", () => {
  const { builder, api, resolve } = createOwner();
  const tool = metadataTool(
    Type.Object(
      Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [String(i), Type.Unsafe({ type: "object" })]),
      ),
    ),
  );
  api.registerTool(() => tool, { name: "metadata" });
  resolve();
  const message = builder.registry.diagnostics[0]!.message;
  expect(message).toContain("metadata.parameters.properties.11");
  expect(message).not.toContain("metadata.parameters.properties.12");
  expect(message).toContain("+3 more");
});
