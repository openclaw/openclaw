/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loginHarness, openLogin } from "./model-providers-page.login.test-support.ts";
import { appendPage, submitCredential, unmountPage } from "./model-providers-page.test-support.tsx";

it.each([
  { recommended: false, delayed: false },
  { recommended: true, delayed: true },
  { recommended: false, delayed: false, verified: true },
  { recommended: true, delayed: false, cancel: true },
  // The Gateway's own routing is not a choice: Start Chat must not pin it on the session.
  { recommended: true, delayed: false, runtimeSource: "implicit" as const },
])(
  "Start Chat offers the first available recommendation (recommended: $recommended, delayed: $delayed, runtime: $runtimeSource)",
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
        "Example API key is connected",
      ),
    );
    if (recommended || verified) {
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
        expect(page.querySelector(".model-setup-wizard")?.textContent).toContain("Request failed");
      }
    } else {
      await waitForSolid(() =>
        expect(request.mock.calls.some(([method]) => method === "models.list")).toBe(true),
      );
      expect(startChat()).toBeNull();
    }
    expect(context.runtimeConfig.patch).not.toHaveBeenCalled();
    unmountPage(page);
    if (cancel) {
      expect(signal?.aborted).toBe(true);
    }
  },
);
