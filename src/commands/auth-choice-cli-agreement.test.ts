import { Command } from "commander";
import { assert, expect, it, vi } from "vitest";
import { applyNonInteractiveAuthChoice } from "./onboard-non-interactive/local/auth-choice.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

// mock-isolation: A fixed provider catalog makes advertised and accepted CLI choices deterministic.
vi.mock("../flows/provider-flow.js", () => ({
  resolveProviderSetupFlowContributions: () => [
    { option: { value: "demo-api-key" } },
    { option: { value: "demo-cli" } },
  ],
}));

// The legacy alias must normalize before either advertised/accepted list is consulted.
const DEPRECATED_ALIAS = "claude-cli";

// mock-isolation: Synthetic aliases and flags avoid consulting installed provider manifests.
vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveProviderOnboardAuthFlags: () => [],
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
  assert(
    description && description.startsWith("Auth: "),
    `unexpected --auth-choice help text: ${description}`,
  );
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
  assert(listed, `unexpected rejection message: ${String(message)}`);
  return listed.split(", ");
}

it("onboard help advertises exactly the choices the non-interactive dispatcher accepts", async () => {
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
