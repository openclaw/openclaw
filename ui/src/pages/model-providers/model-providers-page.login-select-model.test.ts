/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
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

// A local model (for example a running llama.cpp) is available, but it is not the agent's choice.
const localModel = { provider: "llama-cpp", id: "local", name: "Local model", available: true };

it.each([
  { primary: undefined, selects: true },
  { primary: "llama-cpp/local", selects: false },
])(
  "a browser sign-in selects the first model only for an agent without one (primary: $primary)",
  async ({ primary, selects }) => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, answer } = loginHarness();
    const originalRequest = request.getMockImplementation()!;
    // Hold every catalog read after sign-in: the dialog must not depend on one.
    const laterCatalog = deferred<unknown>();
    let catalogReads = 0;
    request.mockImplementation(async (method, ...args) => {
      if (method === "config.get") {
        return {
          config: { agents: { defaults: primary ? { model: { primary } } : {} } },
          hash: "hash",
          valid: true,
        };
      }
      if (method === "models.list") {
        return ++catalogReads === 1 ? { models: [localModel] } : laterCatalog.promise;
      }
      return originalRequest(method, ...args);
    });
    const create = vi.fn(async () => null);
    Object.assign(context, { sessions: { create, state: {} } });
    const page = appendPage(context);
    const text = (selector: string) => page.querySelector(selector)?.textContent?.trim();
    try {
      await openPicker(page);
      await selectProvider(page, "example");
      await startSelectedLogin(page, "Example browser sign-in");
      const login = (request.mock.calls as unknown[][]).find(
        ([method]) => method === "models.authLogin",
      )?.[1] as { authChoice?: string; selectModel?: true } | undefined;
      expect(login?.authChoice).toBe("example-browser");
      expect(login?.selectModel).toBe(selects ? true : undefined);
      await submitCredential(page);
      answer.resolve({
        done: true,
        status: "done",
        ...(selects
          ? { modelActivation: { modelRef: "example/best", modelName: "Example best" } }
          : {}),
      });
      if (selects) {
        await waitForSolid(() =>
          expect(text("[data-login-start-chat]")).toBe("Start a new chat with Example best"),
        );
        expect(text(".model-setup-wizard__success-description")).toBe(
          "Example best is ready for your agent.",
        );
      } else {
        await waitForSolid(() =>
          expect(text(".model-setup-wizard")).toContain("Example browser sign-in connected"),
        );
        expect(page.querySelector("[data-login-start-chat]")).toBeNull();
      }
    } finally {
      laterCatalog.resolve({ models: [localModel] });
      unmountPage(page);
    }
  },
);

it("names the account a sign-in connected under its heading", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  const { context, request, answer } = loginHarness();
  const originalRequest = request.getMockImplementation()!;
  request.mockImplementation(async (method, ...args) => {
    const response = await originalRequest(method, ...args);
    if (method === "models.authStatus") {
      for (const provider of (response as ModelAuthStatusResult).providers) {
        for (const profile of provider.profiles) {
          profile.email = "user@example.com";
        }
      }
    }
    return response;
  });
  const page = appendPage(context);
  const text = (selector: string) => page.querySelector(selector)?.textContent?.trim();
  try {
    await openPicker(page);
    await selectProvider(page, "example");
    await startSelectedLogin(page, "Example browser sign-in");
    await submitCredential(page);
    answer.resolve({ done: true, status: "done" });
    await waitForSolid(() =>
      expect(text(".model-setup-wizard__success-description")).toBe("user@example.com"),
    );
    expect(text(".model-setup-wizard__success-title")).toBe("Example browser sign-in connected");
  } finally {
    unmountPage(page);
  }
});
