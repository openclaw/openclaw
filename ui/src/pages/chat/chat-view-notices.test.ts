/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { renderChatComposerNotices } from "./chat-view-notices.ts";

afterEach(() => {
  document.body.replaceChildren();
});

it.each([
  ["buffering", "status", "OpenAI is reviewing this response for cyber safety."],
  ["blocked", "alert", "OpenAI blocked this response under its cyber policy."],
  ["fallback", "status", "OpenAI routed this response to <img src=x onerror=alert(1)>."],
  ["escalated", "status", "OpenAI declined this request; retried on <img src=x onerror=alert(1)>."],
  [
    "unavailable",
    "alert",
    "OpenAI declined this request; <img src=x onerror=alert(1)> is not authorized.",
  ],
] as const)(
  "renders the %s provider notice above the composer as plain text",
  (state, role, copy) => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderChatComposerNotices({
        messages: [],
        providerPolicyNotice: {
          runId: "run-1",
          seq: 1,
          state,
          model: "original-model",
          fallbackModel: "<img src=x onerror=alert(1)>",
        },
      }),
      container,
    );
    const notice = container.querySelector(".chat-provider-policy-notice");
    expect(notice?.getAttribute("role")).toBe(role);
    expect(notice?.textContent).toContain(copy);
    expect(notice?.querySelector("img, button")).toBeNull();

    render(renderChatComposerNotices({ messages: [] }), container);
    expect(container.querySelector(".chat-provider-policy-notice")).toBeNull();
  },
);

it("offers an explicit discard action with the full warning when unsaved starts block recovery", () => {
  const discardAndReload = vi.fn();
  const retry = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));

  render(
    renderChatComposerNotices({
      messages: [],
      placementStartup: {
        sessionKey: "agent:main:unsaved-start",
        phase: "failed",
        startedAt: 1,
        retryable: false,
        error: t("newSession.placementReloadBlocked"),
        discardAndReload,
      },
      onRetrySessionPlacementStartup: retry,
    }),
    container,
  );

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.querySelector("details")).toBeNull();
  expect(alert?.textContent).toContain("Recovery needs a reload. Unsaved starts will be lost.");
  const action = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Discard unsaved starts and reload",
  );
  expect(action).toBeDefined();
  expect(discardAndReload).not.toHaveBeenCalled();

  action?.click();

  expect(discardAndReload).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
});
