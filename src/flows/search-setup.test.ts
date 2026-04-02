import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { runSearchSetupFlow } from "./search-setup.js";

describe("runSearchSetupFlow", () => {
  it("runs provider-owned setup after selecting Grok web search", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("grok")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("grok-4-1-fast");
    const text = vi.fn().mockResolvedValue("xai-test-key");
    const prompter = createWizardPrompter({
      select: select as never,
      text: text as never,
    });

    const next = await runSearchSetupFlow(
      { plugins: { allow: ["xai"] } },
      createNonExitingRuntime(),
      prompter,
    );

    expect(next.plugins?.entries?.xai?.config?.webSearch).toMatchObject({
      apiKey: "xai-test-key",
    });
    expect(next.tools?.web?.search).toMatchObject({
      provider: "grok",
      enabled: true,
    });
    expect(next.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });

  it("preserves disabled web_search state while still allowing provider-owned x_search setup", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("grok")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("grok-4-1-fast");
    const prompter = createWizardPrompter({
      select: select as never,
    });

    const next = await runSearchSetupFlow(
      {
        plugins: {
          allow: ["xai"],
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "xai-test-key",
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              provider: "grok",
              enabled: false,
            },
          },
        },
      },
      createNonExitingRuntime(),
      prompter,
    );

    expect(next.tools?.web?.search).toMatchObject({
      provider: "grok",
      enabled: false,
    });
    expect(next.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });
});
