/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { WizardNextResult } from "../../api/types.ts";
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
it("shows distinct verification and activation phases before offering the named Muse starter", async () => {
  const { context, request, answer } = loginHarness({
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
  const activation = deferred<WizardNextResult>();
  const completion = deferred<WizardNextResult>();
  const loginRequest = request.getMockImplementation()!;
  let nextRequests = 0;
  request.mockImplementation(async (method) => {
    if (method === "wizard.next") {
      nextRequests += 1;
      if (nextRequests === 3) {
        return activation.promise;
      }
      if (nextRequests === 4) {
        return completion.promise;
      }
    }
    return loginRequest(method);
  });
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
  await startSelectedLogin(page, "Muse Code");
  await submitCredential(page);
  answer.resolve({
    done: false,
    status: "running",
    step: {
      id: "verification",
      type: "progress",
      executor: "gateway",
      message: "Testing your AI connection…",
    },
  });
  try {
    await waitForSolid(() =>
      expect(page.querySelector(".wizard-step__progress[role='status']")?.textContent?.trim()).toBe(
        "Testing your AI connection…",
      ),
    );
    expect(page.querySelector("[data-login-start-chat]")).toBeNull();
    activation.resolve({
      done: false,
      status: "running",
      step: {
        id: "activation",
        type: "progress",
        executor: "gateway",
        message: "Turning on your AI connection…",
      },
    });
    await waitForSolid(() =>
      expect(page.querySelector(".wizard-step__progress[role='status']")?.textContent?.trim()).toBe(
        "Turning on your AI connection…",
      ),
    );
    expect(page.querySelector(".model-setup-wizard")?.textContent).not.toContain(
      "Testing your AI connection…",
    );
    expect(page.querySelector("[data-login-start-chat]")).toBeNull();
    completion.resolve({
      done: true,
      status: "done",
      modelActivation: { modelRef: "meta/muse-spark-1.3", modelName: "Muse Spark 1.3" },
    });
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
      expect(create).toHaveBeenCalledWith(
        { agentId: "writer", model: "meta/muse-spark-1.3" },
        { signal: expect.any(AbortSignal) },
      ),
    );
  } finally {
    activation.resolve({ done: true, status: "cancelled" });
    completion.resolve({ done: true, status: "cancelled" });
    refresh.resolve();
    unmountPage(page);
  }
});
