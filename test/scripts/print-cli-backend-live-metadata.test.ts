// Print Cli Backend Live Metadata tests cover print cli backend live metadata script behavior.
import { describe, expect, it, vi } from "vitest";
import {
  resolveCliBackendDockerPackages,
  resolveCliBackendLiveMetadata,
} from "../../scripts/print-cli-backend-live-metadata.js";

vi.mock("../../src/agents/cli-backends.js", () => ({
  resolveCliBackendConfig: () => ({ config: { command: "fixture-cli" } }),
  resolveCliBackendLiveTest: (provider: string) => ({
    defaultModelRef: `${provider}/model`,
    ...(["fixture-cli", "fixture-cli-alias"].includes(provider)
      ? { dockerNpmPackage: "@fixture/cli@1.2.3" }
      : {}),
  }),
}));
vi.mock("../../src/plugins/setup-registry.js", () => ({
  resolvePluginSetupRegistry: () => ({
    cliBackends: [{ backend: { id: "fixture-cli", modelProvider: "fixture-provider" } }],
  }),
}));

describe("print-cli-backend-live-metadata", () => {
  it.each([
    {
      providers: ["fixture-cli", "fixture-cli-alias", "api-provider"],
      models: [],
      expected: ["@fixture/cli@1.2.3"],
    },
    {
      providers: ["api-provider"],
      models: ["fixture-cli/one", "fixture-cli/two", "api-provider/model"],
      expected: ["@fixture/cli@1.2.3"],
    },
    {
      providers: [" api-provider ", "all", ""],
      models: [" FIXTURE-PROVIDER/model "],
      expected: ["@fixture/cli@1.2.3"],
    },
    {
      providers: [" FIXTURE-PROVIDER ", " all ", ""],
      models: [],
      expected: ["@fixture/cli@1.2.3"],
    },
    {
      providers: ["api-provider"],
      models: ["modern", "small", "all", "fixture-cli/"],
      expected: [],
    },
    { providers: [" ", " all "], models: [], expected: ["@fixture/cli@1.2.3"] },
  ])(
    "resolves selected Docker CLI packages: $providers / $models",
    async ({ providers, models, expected }) => {
      expect(await resolveCliBackendDockerPackages(providers, models)).toEqual(expected);
    },
  );

  it("keeps unrestricted provider selection for a model selector without a provider", async () => {
    expect(await resolveCliBackendDockerPackages([], ["modern"])).toEqual(["@fixture/cli@1.2.3"]);
  });

  it("builds one unsupported codex-cli metadata payload", async () => {
    expect(await resolveCliBackendLiveMetadata("codex-cli")).toEqual({
      provider: "codex-cli",
      unsupported: true,
      reason:
        "codex-cli is no longer a bundled CLI backend. Use openai/* with the Codex app-server runtime instead.",
    });
  });
});
