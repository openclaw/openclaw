// Covers provider auth choice selection for plugin-owned providers.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { runProviderPluginAuthMethodUnpersisted } from "./provider-auth-method.js";
import type { ProviderPlugin } from "./types.js";

describe("runProviderPluginAuthMethodUnpersisted", () => {
  it("delegates remote browser destinations to structured wizard clients", async () => {
    const openUrl = vi.fn(async () => undefined);
    const method: ProviderPlugin["auth"][number] = {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        await ctx.openUrl("https://provider.example/oauth?state=state-1");
        return { profiles: [] };
      },
    };

    await runProviderPluginAuthMethodUnpersisted({
      config: {},
      runtime: createNonExitingRuntime(),
      isRemote: true,
      prompter: { ...createWizardPrompter(), openUrl },
      method,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(openUrl).toHaveBeenCalledWith("https://provider.example/oauth?state=state-1");
  });
});
