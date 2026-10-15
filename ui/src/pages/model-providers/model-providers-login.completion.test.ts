/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  loginHarness,
  openPicker,
  selectProvider,
} from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  startSelectedLogin,
  submitCredential,
  unmountPage,
} from "./model-providers-page.test-support.tsx";
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
it("offers the named Muse starter before catalog and config reconciliation", async () => {
  const { context, answer } = loginHarness({
    capabilities: [
      {
        provider: "meta",
        apiKeySupported: true,
        quickApiKeySetup: true,
        loginOptions: [
          {
            id: "meta/muse-code",
            brandId: "meta",
            label: "Muse Code",
            kind: "device-code",
            featured: true,
            requiresSetup: true,
          },
        ],
      },
    ],
  });
  const refresh = deferred();
  context.runtimeConfig.runExternalMutation = async (task) => {
    const value = await task(context.gateway.snapshot.client!);
    if (value) {
      await refresh.promise;
    }
    return { ok: true, value, refresh: { ok: true } };
  };
  const create = vi.fn(async () => null);
  Object.assign(context, { sessions: { create, state: {} } });
  const page = appendPage(context);
  await openPicker(page);
  await selectProvider(page, "meta");
  await startSelectedLogin(page, "meta/muse-code");
  await submitCredential(page);
  answer.resolve({
    done: true,
    status: "done",
    modelActivation: { modelRef: "meta/muse-spark-1.3", modelName: "Muse Spark 1.3" },
  });
  try {
    await waitForSolid(() =>
      expect(page.querySelector("[data-login-start-chat]")?.textContent).toBe(
        "Start a new chat with Muse Spark 1.3",
      ),
    );
    expect(page.querySelector(".model-setup-wizard__success-title")?.textContent).toBe(
      "Muse Code is connected",
    );
    expect(page.querySelector(".model-setup-wizard__success-description")?.textContent).toBe(
      "Muse Spark 1.3 is ready for your agent.",
    );
    expect(page.querySelector(".model-setup-wizard")?.textContent).not.toContain(
      "meta/muse-spark-1.3",
    );
    page.querySelector<HTMLButtonElement>("[data-login-start-chat]")!.click();
    await waitForSolid(() =>
      expect(create).toHaveBeenCalledWith({ agentId: "writer", model: "meta/muse-spark-1.3" }),
    );
  } finally {
    refresh.resolve();
    unmountPage(page);
  }
});
