import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { applyNonInteractiveAuthChoice } from "./onboard-non-interactive/local/auth-choice.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const PROVIDER_SETUP_CONTRIBUTIONS = [
  { providerId: "demo", option: { value: "demo-api-key", label: "Demo API key" } },
  { providerId: "demo", option: { value: "demo-cli", label: "Demo CLI" } },
];

vi.mock("../flows/provider-flow.js", () => ({
  resolveProviderSetupFlowContributions: () => PROVIDER_SETUP_CONTRIBUTIONS,
}));

// The legacy alias must normalize before either advertised/accepted list is consulted.
const DEPRECATED_ALIAS = "claude-cli";

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveProviderOnboardAuthFlags: () => [],
  resolveManifestProviderAuthChoices: () => [
    {
      pluginId: "demo",
      providerId: "demo",
      methodId: "cli",
      choiceId: "demo-cli",
      choiceLabel: "Demo CLI",
      deprecatedChoiceIds: [DEPRECATED_ALIAS],
    },
  ],
  resolveManifestDeprecatedProviderAuthChoice: (choiceId: string) =>
    choiceId === DEPRECATED_ALIAS
      ? { choiceId: "demo-cli", choiceLabel: "Demo CLI", providerId: "demo" }
      : undefined,
}));

vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveDeprecatedProviderInstallCatalogEntry: () => undefined,
}));

vi.mock("./onboard-non-interactive/local/auth-choice.plugin-providers.js", () => ({
  applyNonInteractivePluginProviderChoice: async () => undefined,
}));

vi.mock("./onboard-recommendations.js", () => ({
  acknowledgeOnboardRecommendationsCommand: vi.fn(),
  onboardRecommendationsCommand: vi.fn(),
  refreshOnboardRecommendationsCommand: vi.fn(),
}));

async function readHelpAuthChoices(): Promise<string[]> {
  const { registerOnboardCommand } = await import("../cli/program/register.onboard.js");
  const program = new Command();
  registerOnboardCommand(program);
  const onboard = program.commands.find((command) => command.name() === "onboard");
  const description = onboard?.options.find(
    (option) => option.long === "--auth-choice",
  )?.description;
  if (!description?.startsWith("Auth: ")) {
    throw new Error(`unexpected --auth-choice help text: ${String(description)}`);
  }
  return description.slice("Auth: ".length).split("|");
}

async function readAcceptedAuthChoices(rejectedChoice: string): Promise<string[]> {
  const runtime = createTestRuntime();
  const result = await applyNonInteractiveAuthChoice({
    nextConfig: {},
    authChoice: rejectedChoice,
    opts: {},
    runtime,
    baseConfig: {},
    target: { agentId: "main", agentDir: "/tmp/agent", workspaceDir: "/tmp/workspace" },
  });
  expect(result).toBeNull();
  expect(runtime.exit).toHaveBeenCalledWith(1);
  const message = runtime.error.mock.calls.at(0)?.at(0);
  const listed = /Valid choices: (.*)\.$/.exec(String(message))?.[1];
  if (!listed) {
    throw new Error(`unexpected rejection message: ${String(message)}`);
  }
  return listed.split(", ");
}

describe("onboard --auth-choice help and validation agreement", () => {
  it("advertises exactly the choices the non-interactive dispatcher accepts", async () => {
    const help = await readHelpAuthChoices();
    const accepted = await readAcceptedAuthChoices("definitely-not-an-auth-choice");

    expect([...help].toSorted()).toEqual([...accepted].toSorted());
    // Guard against both lists collapsing to an empty set and passing vacuously.
    expect(help).toContain("demo-api-key");
    expect(help).toContain("custom-api-key");
    expect(help).toContain("skip");
    expect(help).toEqual(expect.arrayContaining(["setup-token", "token", "apiKey"]));
    expect(help).not.toContain(DEPRECATED_ALIAS);
    expect(accepted).not.toContain(DEPRECATED_ALIAS);
  });
});
