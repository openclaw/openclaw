/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import { loginOption } from "../../test-helpers/model-providers.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loginHarness, openLogin } from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  createEmptyModelProvidersRouteData,
  startSelectedLogin,
  submitCredential,
  unmountPage,
} from "./model-providers-page.test-support.tsx";

it("opens the plugin-owned sign-in and offers a chat model without changing the default", async () => {
  const { context, request, answer } = loginHarness({
    capabilities: [
      {
        provider: "example",
        apiKeySupported: false,
        quickApiKeySetup: false,
        loginOptions: [
          loginOption("other/oauth", "example", "Foreign account", "oauth", { pluginId: "other" }),
          loginOption("fixture-plugin/login", "example", "Sign in with Example", "oauth", {
            pluginId: "fixture-plugin",
            groupLabel: "Example Cloud",
          }),
        ],
      },
      { provider: "alternate", apiKeySupported: true, quickApiKeySetup: true },
    ],
  });
  const originalRequest = request.getMockImplementation()!;
  request.mockImplementation(async (method, ...args) =>
    method === "models.list"
      ? ({
          models: [
            { provider: "alternate", id: "studio", name: "Other model", available: true },
            { provider: "example", id: "retired", name: "Retired model", available: false },
            { provider: "example", id: "flash", name: "Example Flash", available: true },
          ],
        } satisfies ModelCatalogResult)
      : originalRequest(method, ...args),
  );
  const create = vi.fn(async () => null);
  Object.assign(context, { sessions: { create, state: {} } });
  const page = appendPage(context);
  try {
    page.routeData = {
      ...createEmptyModelProvidersRouteData(context),
      connect: true,
      pluginId: "fixture-plugin",
    };
    await waitForSolid(() =>
      expect(page.querySelector(".model-provider-login h2")?.textContent).toContain(
        "Example Cloud",
      ),
    );
    expect(page.querySelector(".model-provider-login")?.textContent).not.toContain(
      "Foreign account",
    );
    await startSelectedLogin(page, "Sign in with Example");
    await submitCredential(page);
    answer.resolve({ done: true, status: "done" });
    const action = () => page.querySelector<HTMLButtonElement>("[data-login-start-chat]");
    await waitForSolid(() => expect(action()?.textContent).toBe("Choose a model"));
    action()!.click();
    await waitForSolid(() =>
      expect(action()?.textContent).toBe("Start a new chat with Example Flash"),
    );
    expect(create).not.toHaveBeenCalled();
    action()!.click();
    await waitForSolid(() =>
      expect(create).toHaveBeenCalledWith(
        { agentId: "writer", model: "example/flash" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(context.runtimeConfig.patch).not.toHaveBeenCalled();
  } finally {
    unmountPage(page);
  }
});

it.each([
  { recommended: false, delayed: false },
  { recommended: true, delayed: true },
  { recommended: false, delayed: false, verified: true },
  { recommended: true, delayed: false, cancel: true },
  // The Gateway's own routing is not a choice: Start Chat must not pin it on the session.
  { recommended: true, delayed: false, runtimeSource: "implicit" as const },
])(
  "Model choice defaults to the first available recommendation or model (recommended: $recommended, delayed: $delayed, runtime: $runtimeSource)",
  async ({ recommended, delayed, verified, cancel, runtimeSource = "model" as const }) => {
    const { context, request, answer, publishEvent } = loginHarness();
    const originalRequest = request.getMockImplementation()!;
    let available = !delayed;
    const model = (id: string, overrides: Partial<ModelCatalogEntry> = {}) => ({
      provider: "example",
      id,
      name: `Example ${id}`,
      recommended,
      available,
      ...overrides,
    });
    request.mockImplementation(async (method, ...args) =>
      method === "models.list"
        ? ({
            models: [
              model("best", { provider: "other", recommended: true, available: true }),
              model("old", { recommended: true, available: false }),
              model("best", { agentRuntime: { id: "openclaw", source: runtimeSource } }),
              model("second"),
            ],
          } satisfies ModelCatalogResult)
        : originalRequest(method, ...args),
    );
    const creation = deferred<null>();
    let signal: AbortSignal | undefined;
    const create = vi.fn(async (_params: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      if (cancel && signal) {
        return new Promise<null>((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), { once: true });
        });
      }
      return creation.promise;
    });
    Object.assign(context, { sessions: { create, state: {} } });
    const page = appendPage(context);
    const startChat = () => page.querySelector<HTMLButtonElement>("[data-login-start-chat]");
    await openLogin(page);
    await submitCredential(page);
    answer.resolve({
      done: true,
      status: "done",
      ...(verified ? { modelActivation: { modelRef: "example/best" } } : {}),
    });
    await waitForSolid(() =>
      expect(page.querySelector(".model-setup-wizard")?.textContent).toContain(
        "Example API key is ready",
      ),
    );
    if (delayed) {
      await waitForSolid(() =>
        expect(request).toHaveBeenCalledWith(
          "models.list",
          expect.objectContaining({ agentId: "writer" }),
        ),
      );
      expect(startChat()).toBeNull();
      available = true;
      publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
    }
    await waitForSolid(() => expect(startChat()?.textContent).toBe("Choose a model"));
    startChat()!.click();
    await waitForSolid(() =>
      expect(startChat()?.textContent).toBe("Start a new chat with Example best"),
    );
    startChat()!.click();
    await waitForSolid(() =>
      expect(create).toHaveBeenCalledWith(
        {
          agentId: "writer",
          model: "example/best",
          ...(runtimeSource === "model" ? { agentRuntime: "openclaw" } : {}),
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    const button = startChat()!;
    await waitForSolid(() => expect(button.disabled).toBe(true));
    button.click();
    expect(create).toHaveBeenCalledTimes(1);
    if (!cancel) {
      creation.resolve(null);
      await waitForSolid(() => expect(button.disabled).toBe(false));
      expect(startChat()).toBe(button);
      expect(page.querySelector(".model-setup-wizard")?.textContent).toContain(
        "Couldn’t complete the request. Try again.",
      );
    }
    expect(context.runtimeConfig.patch).not.toHaveBeenCalled();
    unmountPage(page);
    if (cancel) {
      expect(signal?.aborted).toBe(true);
    }
  },
);
