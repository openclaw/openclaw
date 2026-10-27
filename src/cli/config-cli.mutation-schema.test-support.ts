import { describe, expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ConfigCliWriter } from "./config-cli.snapshot.test-support.js";

type ConfigMutationSchemaFixture = {
  runConfigCommand: (args: string[]) => Promise<void>;
  runConfigSet: (...args: string[]) => Promise<void>;
  setSnapshot: (resolved: OpenClawConfig, config: OpenClawConfig) => void;
  firstWrittenConfig: () => OpenClawConfig;
  writeTempJson5File: (prefix: string, value: unknown) => string;
  mockReadBestEffortRuntimeConfigSchema: Mock;
  mockWriteConfigFile: Mock<ConfigCliWriter>;
};

function objectSchema(properties: Record<string, unknown>) {
  return { type: "object", properties };
}

const proxy = (requiredHeaders?: string[]) => ({
  gateway: {
    auth: {
      trustedProxy: { userHeader: "X-User", ...(requiredHeaders ? { requiredHeaders } : {}) },
    },
  },
});
const numericModel = () => ({ agents: { defaults: { models: { "0": { alias: "zero" } } } } });

export function registerConfigMutationSchemaTests({
  runConfigCommand,
  runConfigSet,
  setSnapshot,
  firstWrittenConfig,
  writeTempJson5File,
  mockReadBestEffortRuntimeConfigSchema,
  mockWriteConfigFile,
}: ConfigMutationSchemaFixture) {
  describe("config mutation schemas", () => {
    it.each([
      [["set", "gateway.mode", "local"], {}, { gateway: { mode: "local" } }],
      [
        ["unset", "gateway.mode"],
        { gateway: { mode: "local", port: 18789 } },
        { gateway: { port: 18789 } },
      ],
      [
        [
          "set",
          "gateway.auth.trustedProxy.requiredHeaders[0]",
          '"X-Forwarded-Proto"',
          "--strict-json",
        ],
        proxy(),
        proxy(["X-Forwarded-Proto"]),
      ],
      [["set", 'agents.defaults.models["0"].alias', '"zero"', "--strict-json"], {}, numericModel()],
    ] satisfies [string[], OpenClawConfig, OpenClawConfig][])(
      "applies %j without loading a mutation schema",
      async (args, resolved, expected) => {
        setSnapshot(resolved, resolved);
        await runConfigCommand(["config", ...args]);
        expect(firstWrittenConfig()).toEqual(expected);
        expect(mockReadBestEffortRuntimeConfigSchema).not.toHaveBeenCalled();
      },
    );

    it("shares a prepared schema across ambiguous numeric paths and redaction restoration", async () => {
      const resolved = proxy();
      setSnapshot(resolved, resolved);
      mockReadBestEffortRuntimeConfigSchema.mockResolvedValueOnce({
        schema: objectSchema({
          agents: objectSchema({
            defaults: objectSchema({
              models: { type: "object", additionalProperties: { type: "object" } },
            }),
          }),
        }),
        uiHints: { "gateway.auth.trustedProxy.userHeader": { sensitive: true } },
      });
      await runConfigSet(
        "--batch-json",
        JSON.stringify([
          { path: "agents.defaults.models.0.alias", value: "zero" },
          { path: "agents.defaults.models.1.alias", value: "one" },
          { path: "gateway.auth.trustedProxy.userHeader", value: "__OPENCLAW_REDACTED__" },
        ]),
      );
      expect(firstWrittenConfig()).toEqual({
        ...resolved,
        agents: { defaults: { models: { "0": { alias: "zero" }, "1": { alias: "one" } } } },
      });
      expect(mockReadBestEffortRuntimeConfigSchema).toHaveBeenCalledTimes(1);
      expect(mockReadBestEffortRuntimeConfigSchema).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({ sourceConfig: resolved }),
        }),
      );
    });

    it("keeps numeric patch keys as objects without loading a mutation schema", async () => {
      const patch = numericModel();
      const pathname = writeTempJson5File("openclaw-config-patch-numeric-", patch);
      await runConfigCommand(["config", "patch", "--file", pathname]);
      expect(firstWrittenConfig()).toEqual(patch);
      expect(mockReadBestEffortRuntimeConfigSchema).not.toHaveBeenCalled();
    });

    it("canonicalizes schema-backed numeric agent list indexes before writing", async () => {
      mockReadBestEffortRuntimeConfigSchema.mockResolvedValueOnce({
        schema: objectSchema({
          agents: objectSchema({
            list: { type: "array", items: objectSchema({ id: { type: "string" } }) },
          }),
        }),
      });
      const resolved: OpenClawConfig = {};
      setSnapshot(resolved, resolved);
      await runConfigSet("agents.list.0.id", '"tech"', "--strict-json");
      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = firstWrittenConfig();
      expect(written.agents?.entries).toEqual({ tech: {} });
      expect(written.agents).not.toHaveProperty("list");
    });
  });
}
