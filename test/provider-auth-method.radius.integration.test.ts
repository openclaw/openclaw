import { afterEach, expect, it, vi } from "vitest";
import radiusPlugin from "../extensions/radius/index.js";
import { runProviderPluginAuthMethodUnpersisted } from "../src/plugins/provider-auth-method.js";
import { createNonExitingRuntime } from "../src/runtime.js";
import { registerSingleProviderPlugin } from "../src/test-utils/plugin-registration.js";
import { WizardSession } from "../src/wizard/session.js";

const { openHostBrowser, guardedFetch } = vi.hoisted(() => ({
  openHostBrowser: vi.fn(async () => true),
  guardedFetch: vi.fn(),
}));
vi.mock("../src/infra/browser-open.js", () => ({ openUrl: openHostBrowser }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

afterEach(() => vi.clearAllMocks());

it.each([false, true])(
  "keeps the registered Radius device destination with its code and cancellation (remote=%s)",
  async (isRemote) => {
    guardedFetch.mockResolvedValueOnce({
      response: Response.json({
        device_code: "synthetic-device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://radius.earendil.com/device",
        expires_in: 300,
        interval: 5,
      }),
      release: async () => undefined,
    });
    const provider = await registerSingleProviderPlugin(radiusPlugin);
    const method = provider.auth.find((entry) => entry.id === "oauth");
    if (!method) {
      throw new Error("Radius did not register its OAuth method");
    }
    const session = new WizardSession(async (prompter, signal) => {
      await runProviderPluginAuthMethodUnpersisted({
        config: {},
        runtime: createNonExitingRuntime(),
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
        externalUrl: "https://radius.earendil.com/device",
        deviceCode: { code: "ABCD-EFGH", expiresInMinutes: 5 },
      });
      expect(openHostBrowser).not.toHaveBeenCalled();
      session.cancel();
      expect(await session.next()).toMatchObject({ done: true, status: "cancelled" });
    } finally {
      session.cancel();
      await session.whenSettled();
    }
    expect(guardedFetch).toHaveBeenCalledOnce();
  },
);
