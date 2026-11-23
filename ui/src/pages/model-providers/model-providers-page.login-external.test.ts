/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loginOption } from "../../test-helpers/model-providers.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { chooseLogin, loginHarness } from "./model-providers-page.login.test-support.ts";
import { appendPage, unmountPage } from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Models provider login", () => {
  it("keeps the browser sign-in link visible while its automatic callback read is held", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, answer, cancel } = loginHarness();
    const originalRequest = request.getMockImplementation()!;
    let noteShown = false;
    request.mockImplementation(async (method) => {
      if (method !== "wizard.next") {
        return originalRequest(method);
      }
      if (noteShown) {
        return answer.promise;
      }
      noteShown = true;
      return {
        done: false,
        status: "running",
        step: {
          id: "browser-note",
          type: "note",
          executor: "client",
          message: "Finish signing in in your browser.",
          externalUrl: "https://provider.example/sign-in",
        },
      };
    });
    const page = appendPage(context);
    try {
      await chooseLogin(page, "Example browser sign-in");
      await waitForSolid(() => {
        expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(2);
        expect(page.querySelector<HTMLAnchorElement>(".wizard-step__external-link")?.href).toBe(
          "https://provider.example/sign-in",
        );
        const buttons = [
          ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
        ];
        expect(
          buttons.find((button) => button.getAttribute("aria-label") === "Cancel sign-in")
            ?.disabled,
        ).toBe(false);
        expect(
          buttons.find((button) => button.textContent?.trim() === "Copy sign-in link")?.disabled,
        ).toBe(false);
      });
      expect(request.mock.calls.filter(([method]) => method === "models.authLogin")).toHaveLength(
        1,
      );
    } finally {
      answer.resolve({ done: true, status: "cancelled" });
      cancel.resolve({ status: "cancelled" });
      unmountPage(page);
    }
  });

  it("reads the browser callback for a device-code sign-in that fell back to a pasted address", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, answer, cancel } = loginHarness({
      capabilities: [
        {
          provider: "example",
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            loginOption("example-code", "example", "Example code sign-in", "device-code", {
              featured: true,
            }),
          ],
        },
      ],
    });
    const originalRequest = request.getMockImplementation()!;
    let pasteShown = false;
    request.mockImplementation(async (method) => {
      if (method !== "wizard.next") {
        return originalRequest(method);
      }
      if (pasteShown) {
        return answer.promise;
      }
      pasteShown = true;
      return {
        done: false,
        status: "running",
        step: {
          id: "paste",
          type: "text",
          message: "Paste the address your browser opens",
          externalUrl: "https://provider.example/sign-in",
        },
      };
    });
    const page = appendPage(context);
    try {
      await chooseLogin(page, "Example code sign-in");
      await waitForSolid(
        () => {
          expect(page.querySelector(".wizard-sign-in--paste")).not.toBeNull();
          // Nothing was pasted, so the second read is the automatic one that sees a callback.
          expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(2);
          // The runner reads once a second.
        },
        { timeout: 3000 },
      );
    } finally {
      answer.resolve({ done: true, status: "cancelled" });
      cancel.resolve({ status: "cancelled" });
      unmountPage(page);
    }
  });

  it("keeps a rejected pasted address's reason under the field across automatic callback reads", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, cancel } = loginHarness();
    const originalRequest = request.getMockImplementation()!;
    const step = {
      id: "paste",
      type: "text",
      message: "Paste the address your browser opens",
      externalUrl: "https://provider.example/sign-in",
    };
    const reason = "This address belongs to a different sign-in attempt.";
    request.mockImplementation(async (method: string, params?: unknown) =>
      method === "wizard.next"
        ? {
            done: false,
            status: "running",
            step,
            // The Gateway names the reason only in its reply to the rejected answer.
            ...((params as { answer?: unknown } | undefined)?.answer ? { error: reason } : {}),
          }
        : originalRequest(method),
    );
    const reads = () => request.mock.calls.filter(([method]) => method === "wizard.next").length;
    const page = appendPage(context);
    try {
      await chooseLogin(page, "Example browser sign-in");
      await waitForSolid(() => expect(page.querySelector(".wizard-sign-in--paste")).not.toBeNull());
      const input = page.querySelector<HTMLInputElement>("input[name=wizard-text]")!;
      input.value = "http://localhost:1455/auth/callback?code=c&state=other";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.form!.requestSubmit();
      await waitForSolid(() =>
        expect(page.querySelector("[role=alert]")?.textContent, "answer reply").toBe(reason),
      );
      const afterAnswer = reads();
      // The once-a-second callback read returns the same step without the reason.
      await waitForSolid(() => expect(reads()).toBeGreaterThan(afterAnswer), { timeout: 3000 });
      await waitForSolid(() =>
        expect(page.querySelector("[role=alert]")?.textContent, "after callback read").toBe(reason),
      );
    } finally {
      cancel.resolve({ status: "cancelled" });
      unmountPage(page);
    }
  });

  it("starts a fresh sign-in from a typed failure's Start sign-in again action", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, cancel } = loginHarness({
      capabilities: [
        {
          provider: "example",
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            loginOption("example-code", "example", "Example code sign-in", "device-code", {
              featured: true,
            }),
          ],
        },
      ],
    });
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method === "wizard.next"
        ? {
            done: true,
            status: "error",
            error: "The sign-in code expired before it was approved.",
            reason: "device_code_expired",
          }
        : originalRequest(method),
    );
    const starts = () => request.mock.calls.filter(([method]) => method === "models.authLogin");
    const page = appendPage(context);
    try {
      await chooseLogin(page, "Example code sign-in");
      const startAgain = () =>
        [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")].find(
          (button) => button.textContent?.trim() === "Start sign-in again",
        );
      await waitForSolid(() => expect(startAgain()).toBeDefined());
      expect(starts()).toHaveLength(1);
      startAgain()!.click();
      await waitForSolid(() => expect(starts()).toHaveLength(2));
    } finally {
      cancel.resolve({ status: "cancelled" });
      unmountPage(page);
    }
  });
});
