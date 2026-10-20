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
      {
        args: ["set", "gateway.mode", "local"],
        resolved: {},
        expected: { gateway: { mode: "local" } },
      },
      {
        args: ["unset", "gateway.mode"],
        resolved: { gateway: { mode: "local", port: 18789 } },
        expected: { gateway: { port: 18789 } },
      },
    ] satisfies Array<{ args: string[]; resolved: OpenClawConfig; expected: OpenClawConfig }>)(
      "applies $args without loading a mutation schema",
      async ({ args, resolved, expected }) => {
        setSnapshot(resolved, resolved);

        await runConfigCommand(["config", ...args]);

        expect(firstWrittenConfig()).toEqual(expected);
        expect(mockReadBestEffortRuntimeConfigSchema).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        path: "gateway.auth.trustedProxy.requiredHeaders[0]",
        value: "X-Forwarded-Proto",
        resolved: { gateway: { auth: { trustedProxy: { userHeader: "X-User" } } } },
        expected: {
          gateway: {
            auth: {
              trustedProxy: { userHeader: "X-User", requiredHeaders: ["X-Forwarded-Proto"] },
            },
          },
        },
      },
      {
        path: 'agents.defaults.models["0"].alias',
        value: "zero",
        resolved: {},
        expected: { agents: { defaults: { models: { "0": { alias: "zero" } } } } },
      },
    ] satisfies Array<{
      path: string;
      value: string;
      resolved: OpenClawConfig;
      expected: OpenClawConfig;
    }>)("preserves explicit path identity for $path without loading a schema", async (testCase) => {
      const resolved = testCase.resolved;
      setSnapshot(resolved, resolved);

      await runConfigSet(testCase.path, JSON.stringify(testCase.value), "--strict-json");

      expect(firstWrittenConfig()).toEqual(testCase.expected);
      expect(mockReadBestEffortRuntimeConfigSchema).not.toHaveBeenCalled();
    });

    it("shares a prepared schema across ambiguous numeric paths and redaction restoration", async () => {
      const resolved: OpenClawConfig = {
        gateway: { auth: { trustedProxy: { userHeader: "X-User" } } },
      };
      setSnapshot(resolved, resolved);
      mockReadBestEffortRuntimeConfigSchema.mockResolvedValueOnce({
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                defaults: {
                  type: "object",
                  properties: {
                    models: { type: "object", additionalProperties: { type: "object" } },
                  },
                },
              },
            },
          },
        },
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
      const patch = { agents: { defaults: { models: { "0": { alias: "zero" } } } } };
      const pathname = writeTempJson5File("openclaw-config-patch-numeric-", patch);

      await runConfigCommand(["config", "patch", "--file", pathname]);

      expect(firstWrittenConfig()).toEqual(patch);
      expect(mockReadBestEffortRuntimeConfigSchema).not.toHaveBeenCalled();
    });

    it("canonicalizes schema-backed numeric agent list indexes before writing", async () => {
      mockReadBestEffortRuntimeConfigSchema.mockResolvedValueOnce({
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                list: {
                  type: "array",
                  items: { type: "object", properties: { id: { type: "string" } } },
                },
              },
            },
          },
        },
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
