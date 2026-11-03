import { expect, it, onTestFinished } from "vitest";
import type { ExecutionEnvironmentProviderV1 } from "./execution-environment-types.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";

function owner() {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "environment-example",
    source: "/synthetic/environment-example.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record)!;
  onTestFinished(async () => {
    await instance.dispose();
  });
  return { builder, api, instance };
}

it.each(["local", "sandbox"] as const)(
  "retires retained %s launch adapters with their registered plugin",
  async (kind) => {
    const { builder, api, instance } = owner();
    const facts = {
      credentialScrubEnv: {},
      localIdentityEnv: { EXAMPLE_IDENTITY: "example" },
      excludedStoreNames: [],
      managedLocalIdentity: false,
      wrapLocalLaunch: (argv: readonly string[]) => ["example-bootstrap", ...argv],
    };
    api.registerExecutionEnvironment({
      id: "identity",
      prepare: () => facts,
      formatGitCoauthor: ({ identity }) => ({ name: identity.name, trailer: "verified fixture" }),
      prepareSandbox: async () => ({
        ...facts,
        readOnlyResourceMounts: [],
        inheritedEnvironmentNames: [],
      }),
    });
    const provider = builder.registry.executionEnvironments[0]!.provider;
    const input = { config: {}, agentId: "main", assertCurrent() {} };
    const prepared =
      kind === "local"
        ? provider.prepare(input)
        : await provider.prepareSandbox!({ ...input, backend: "docker", scope: "agent" });
    expect(prepared?.localIdentityEnv).toEqual({ EXAMPLE_IDENTITY: "example" });
    const launch = prepared!.wrapLocalLaunch!;
    expect(launch(["echo", "reviewed-command"])).toEqual([
      "example-bootstrap",
      "echo",
      "reviewed-command",
    ]);
    const format = provider.formatGitCoauthor;
    if (!format) {
      throw new Error("Expected the registered pure formatter");
    }
    const credit = {
      config: {},
      agentId: "main",
      identity: { issuer: "example.test", subject: "verified", name: "Fixture" },
    };
    expect(format(credit)).toEqual({ name: "Fixture", trailer: "verified fixture" });
    await instance.dispose();
    expect(() => format(credit)).toThrow("reloaded or disabled");
    expect(() => launch(["echo", "retired-command"])).toThrow("reloaded or disabled");
    expect(() => provider.prepare(input)).toThrow("reloaded or disabled");
  },
);

it("rejects duplicate and malformed execution registrations without replacing the first owner", () => {
  const { builder, api } = owner();
  const provider: ExecutionEnvironmentProviderV1 = {
    id: "identity",
    prepare: () => ({
      credentialScrubEnv: {},
      localIdentityEnv: {},
      excludedStoreNames: [],
      managedLocalIdentity: false,
    }),
  };
  api.registerExecutionEnvironment(provider);
  api.registerExecutionEnvironment(provider);
  api.registerExecutionEnvironment({ ...provider, id: "../invalid" });
  expect(builder.registry.executionEnvironments).toHaveLength(1);
  expect(builder.registry.diagnostics.map((entry) => entry.message)).toEqual([
    "execution environment already registered: identity",
    "execution environment requires its managed plugin and a valid local ID/preparer",
  ]);
});

it("retains plugin Gateway startup and write metadata without replacing native methods", () => {
  const { builder, api } = owner();
  api.registerGatewayMethod("example.prepare", () => {}, {
    startup: "unavailable-until-sidecars",
    controlPlaneWrite: true,
    since: "2026.10",
  });
  expect(builder.registry.gatewayMethodDescriptors).toContainEqual(
    expect.objectContaining({
      name: "example.prepare",
      startup: "unavailable-until-sidecars",
      controlPlaneWrite: true,
      since: "2026.10",
    }),
  );
});
