/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { renderChatComposerNotices, renderChatTopbarNotices } from "./chat-view-notices.ts";

afterEach(() => {
  document.body.replaceChildren();
});

it.each([
  [
    "transferring",
    25 * 1_024 * 1_024,
    "Updating worker runtime · 25 MB of 100 MB (25%)",
    "Transferring the new worker runtime to this device: 25 MB of 100 MB (25%). The next turn starts when it finishes.",
  ],
  [
    "installing",
    100 * 1_024 * 1_024,
    "Installing worker runtime",
    "Installing the new worker runtime on this device.",
  ],
] as const)(
  "renders worker runtime progress for %s at %s bytes",
  (phase, transferredBytes, title, body) => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderChatTopbarNotices({
        workerRuntimeInstall: {
          phase,
          transferredBytes,
          totalBytes: 100 * 1_024 * 1_024,
          startedAtMs: 1,
          updatedAtMs: 2,
        },
      }),
      container,
    );

    const notice = container.querySelector(".chat-worker-runtime-install-notice");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.querySelector("strong")?.textContent).toBe(title);
    expect(notice?.getAttribute("title")).toBe(body);
    expect(notice?.textContent).toContain(body);

    render(renderChatTopbarNotices({}), container);
    expect(container.querySelector(".chat-worker-runtime-install-notice")).toBeNull();
  },
);

it.each([true, false])("refreshes a failed conversation only while connected=%s", (connected) => {
  const onRefresh = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  render(
    renderChatComposerNotices({
      connected,
      messages: [],
      runError: { summary: "The conversation changed before your message could run." },
      onRefresh,
    }),
    container,
  );
  const refresh = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".chat-error button"),
  ).find((button) => button.textContent?.trim() === "Refresh");
  expect(refresh).toBeDefined();
  expect(refresh?.disabled).toBe(!connected);
  refresh?.click();
  expect(onRefresh).toHaveBeenCalledTimes(connected ? 1 : 0);
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

it.each([true, false])(
  "checks state contention status without retrying while connected=%s",
  (connected) => {
    const onRefresh = vi.fn();
    const onRetrySessionPlacementStartup = vi.fn();
    const diagnostic =
      "Temporarily busy. Check status before trying again.\nState contention: session store; attempts exhausted.\n<img src=x onerror=alert(1)>";
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderChatComposerNotices({
        connected,
        messages: [],
        runError: { kind: "state_contention", summary: diagnostic },
        onRefresh,
        onRetrySessionPlacementStartup,
      }),
      container,
    );
    const notice = container.querySelector(".chat-error");
    expect(notice?.classList.contains("chat-composer-neighbor-card--warn")).toBe(true);
    expect(notice?.classList.contains("chat-composer-neighbor-card--danger")).toBe(false);
    expect(notice?.getAttribute("role")).toBe("status");
    const details = notice?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("strong")?.textContent).toBe(
      "OpenClaw is busy. Check status before trying again.",
    );
    expect(details?.querySelector("pre")?.textContent).toBe(diagnostic);
    expect(notice?.querySelector("img")).toBeNull();
    const check = notice?.querySelector<HTMLButtonElement>(".chat-error__refresh");
    expect(check?.textContent?.trim()).toBe("Check status");
    expect(check?.disabled).toBe(!connected);
    check?.click();
    expect(onRefresh).toHaveBeenCalledTimes(connected ? 1 : 0);
    expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
  },
);
