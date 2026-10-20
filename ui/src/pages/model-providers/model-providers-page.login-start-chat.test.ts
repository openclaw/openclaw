/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loginHarness, openLogin } from "./model-providers-page.login.test-support.ts";
import { appendPage, submitCredential, unmountPage } from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Model-provider Start Chat", () => {
  it.each([
    { recommended: true, delayed: false },
    { recommended: false, delayed: false },
    { recommended: true, delayed: true },
    { recommended: false, delayed: false, verified: true },
    { recommended: true, delayed: false, cancel: true },
  ])(
    "offers the first available recommendation (recommended: $recommended, delayed: $delayed)",
    async ({ recommended, delayed, verified, cancel }) => {
      const { context, request, answer, publishEvent } = loginHarness();
      const originalRequest = request.getMockImplementation()!;
      let available = !delayed;
      request.mockImplementation(async (method, ...args) =>
        method === "models.list"
          ? ({
              models: [
                {
                  provider: "other",
                  id: "best",
                  name: "Other best",
                  recommended: true,
                  available: true,
                },
                {
                  provider: "example",
                  id: "old",
                  name: "Unavailable",
                  recommended: true,
                  available: false,
                },
                {
                  provider: "example",
                  id: "best",
                  name: "Example best",
                  recommended,
                  available,
                  agentRuntime: { id: "openclaw", source: "model" },
                },
                {
                  provider: "example",
                  id: "second",
                  name: "Example second",
                  recommended,
                  available,
                },
              ],
            } satisfies ModelCatalogResult)
          : originalRequest(method, ...args),
      );
      let signal: AbortSignal | undefined;
      const create = vi.fn(async (_params: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        if (cancel && signal) {
          return new Promise<null>((resolve) => {
            signal?.addEventListener("abort", () => resolve(null), { once: true });
          });
        }
        return null;
      });
      Object.assign(context, { sessions: { create, state: {} } });
      const page = appendPage(context);
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
          expect(page.querySelector("[data-login-start-chat]")).toBeNull();
          available = true;
          publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
        }
        await waitForSolid(() =>
          expect(page.querySelector("[data-login-start-chat]")?.textContent).toBe(
            "Start a new chat with Example best",
          ),
        );
        page.querySelector<HTMLButtonElement>("[data-login-start-chat]")!.click();
        await waitForSolid(() =>
          expect(create).toHaveBeenCalledWith(
            {
              agentId: "writer",
              model: "example/best",
              agentRuntime: "openclaw",
            },
            { signal: expect.any(AbortSignal) },
          ),
        );
      } else {
        await waitForSolid(() =>
          expect(
            request.mock.calls.filter(([method]) => method === "models.list").length,
          ).toBeGreaterThan(0),
        );
        expect(page.querySelector("[data-login-start-chat]")).toBeNull();
      }
      expect(context.runtimeConfig.patch).not.toHaveBeenCalled();
      unmountPage(page);
      if (cancel) {
        expect(signal?.aborted).toBe(true);
      }
    },
  );
});
