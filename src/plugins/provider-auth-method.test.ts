import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { runProviderPluginAuthMethodUnpersisted } from "./provider-auth-method.js";
import type { ProviderAuthMethod } from "./provider-authentication.types.js";

const { openHostBrowser } = vi.hoisted(() => ({
  openHostBrowser: vi.fn(async () => true),
}));
vi.mock("../infra/browser-open.js", () => ({ openUrl: openHostBrowser }));

afterEach(() => vi.clearAllMocks());

const destination = "https://provider.example/oauth?state=fixture-state";
const browserMethod: ProviderAuthMethod = {
  id: "oauth",
  label: "OAuth",
  kind: "oauth",
  run: async (ctx) => {
    await ctx.openUrl(destination);
    return { profiles: [] };
  },
};

const options = {
  config: {},
  runtime: createNonExitingRuntime(),
  method: browserMethod,
};

describe("runProviderPluginAuthMethodUnpersisted", () => {
  it.each([false, true])(
    "delivers destinations to presenting clients (remote=%s)",
    async (isRemote) => {
      const openUrl = vi.fn(async () => undefined);
      await runProviderPluginAuthMethodUnpersisted({
        ...options,
        isRemote,
        prompter: createWizardPrompter({ openUrl }),
        method: {
          ...browserMethod,
          run: async (ctx) => {
            expect(ctx.isRemote).toBe(isRemote);
            return browserMethod.run(ctx);
          },
        },
      });
      expect(openUrl).toHaveBeenCalledExactlyOnceWith(destination);
      expect(openHostBrowser).not.toHaveBeenCalled();
    },
  );

  it.each([false, undefined, true])(
    "preserves host opening for non-presenting CLI prompts (remote=%s)",
    async (isRemote) => {
      await runProviderPluginAuthMethodUnpersisted({
        ...options,
        isRemote,
        prompter: createWizardPrompter(),
      });
      if (isRemote === true) {
        expect(openHostBrowser).not.toHaveBeenCalled();
      } else {
        expect(openHostBrowser).toHaveBeenCalledExactlyOnceWith(destination);
      }
    },
  );

  it("keeps explicit browser overrides authoritative", async () => {
    const openUrl = vi.fn(async () => undefined);
    const presentUrl = vi.fn(async () => undefined);
    await runProviderPluginAuthMethodUnpersisted({
      ...options,
      isRemote: false,
      openUrl,
      prompter: createWizardPrompter({ openUrl: presentUrl }),
    });
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(destination);
    expect(presentUrl).not.toHaveBeenCalled();
    expect(openHostBrowser).not.toHaveBeenCalled();
  });
});
