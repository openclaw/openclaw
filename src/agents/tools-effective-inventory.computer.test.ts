import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { resolveEffectiveToolInventory } from "./tools-effective-inventory.js";

it.each([
  { name: "text-only", input: ["text"], available: false },
  { name: "vision", input: ["text", "image"], available: true },
] as const)(
  "lists computer according to the $name model's input",
  async ({ name, input, available }) => {
    await withOpenClawTestState(
      { prefix: "openclaw-computer-inventory-", layout: "split" },
      async (state) => {
        const inventory = await resolveEffectiveToolInventory({
          cfg: { tools: { profile: "full" }, plugins: { enabled: false } },
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          modelProvider: "openai",
          modelId: name,
          runtimeModel: makeProviderModelFixture({
            id: name,
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://example.invalid/v1",
            input: [...input],
          }),
        });

        expect(
          inventory.groups.some(({ tools }) => tools.some(({ id }) => id === "computer")),
        ).toBe(available);
        expect(inventory.toolAccess?.tools.find(({ id }) => id === "computer")).toMatchObject({
          status: available ? "available" : "unavailable",
          reasons: available
            ? []
            : [{ kind: "runtime", label: "The selected model does not support image input" }],
        });
      },
    );
  },
);
