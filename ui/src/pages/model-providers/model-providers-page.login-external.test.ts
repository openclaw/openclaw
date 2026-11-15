/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
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
});
