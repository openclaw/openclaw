import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { WizardSession } from "../wizard/session.js";
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

  it.each([false, true])(
    "keeps device destinations with their code and cancellation (remote=%s)",
    async (isRemote) => {
      let authCancelled = false;
      const method: ProviderAuthMethod = {
        id: "device",
        label: "Provider sign-in",
        kind: "device_code",
        run: async (ctx) => {
          const { signal } = ctx;
          if (!signal || !ctx.prompter.deviceCode) {
            throw new Error("Expected an abortable device-code presenter");
          }
          await ctx.openUrl(destination);
          await ctx.prompter.deviceCode({
            title: "Provider sign-in",
            code: "ABCD-EFGH",
            expiresInMinutes: 5,
          });
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          authCancelled = signal.aborted;
          return { profiles: [] };
        },
      };
      const session = new WizardSession(async (prompter, signal) => {
        await runProviderPluginAuthMethodUnpersisted({
          ...options,
          method,
          prompter,
          signal,
          isRemote,
        });
      });
      try {
        const pending = await session.next();
        expect(pending.step).toMatchObject({
          type: "progress",
          externalUrl: destination,
          deviceCode: { code: "ABCD-EFGH", expiresInMinutes: 5 },
        });
        expect(openHostBrowser).not.toHaveBeenCalled();
        session.cancel();
        expect(await session.next()).toMatchObject({ done: true, status: "cancelled" });
      } finally {
        session.cancel();
        await session.whenSettled();
      }
      expect(authCancelled).toBe(true);
      expect(session.isSettled()).toBe(true);
    },
  );
});
