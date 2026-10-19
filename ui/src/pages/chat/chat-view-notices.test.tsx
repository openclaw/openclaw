/* @vitest-environment jsdom */

import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderChatComposerNotices, renderChatTopbarNotices } from "./chat-view-notices.tsx";

const model = "<img src=x onerror=alert(1)>";
type ComposerProps = Parameters<typeof renderChatComposerNotices>[0];
type TopbarProps = Parameters<typeof renderChatTopbarNotices>[0];

function publishedNotices<P extends object>(Notices: (props: P) => JSX.Element, initial: P) {
  const [props, publish] = createSignal<P>(() => initial);
  return { ...mountSolid(() => <Notices {...props()} />), publish };
}
const publishedComposer = (initial: Omit<ComposerProps, "messages">) =>
  publishedNotices<ComposerProps>(renderChatComposerNotices, { messages: [], ...initial });
function publishHistory(
  publish: (props: ComposerProps) => void,
  initial: ComposerProps,
  check: () => void,
) {
  for (const messages of [[], [{ role: "assistant", content: "Updated history" }]]) {
    publish({
      ...initial,
      messages,
      runError: initial.runError && { ...initial.runError },
      placementStartup: initial.placementStartup && { ...initial.placementStartup },
    });
    flush();
    check();
  }
}
const failedPlacement = (error: string) => ({
  sessionKey: "agent:main:failed-start",
  phase: "failed" as const,
  startedAt: 1,
  retryable: false,
  error,
});

afterEach(() => document.body.replaceChildren());

it.each(["transferring", "installing"] as const)("shows %s worker progress", (phase) => {
  const installing = phase === "installing";
  const title = installing
    ? "Installing worker runtime"
    : "Updating worker runtime · 25 MB of 100 MB (25%)";
  const body = installing
    ? "Installing the new worker runtime on this device."
    : "Transferring the new worker runtime to this device: 25 MB of 100 MB (25%). The next turn starts when it finishes.";
  const { container, publish } = publishedNotices<TopbarProps>(renderChatTopbarNotices, {
    workerRuntimeInstall: {
      phase,
      transferredBytes: (installing ? 100 : 25) * 1_024 * 1_024,
      totalBytes: 100 * 1_024 * 1_024,
      startedAtMs: 1,
      updatedAtMs: 2,
    },
  });
  const notice = container.querySelector(".chat-worker-runtime-install-notice");
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.querySelector("strong")).toMatchObject({ textContent: title });
  expect(notice).toMatchObject({ title: body, textContent: expect.stringContaining(body) });

  publish({});
  flush();
  expect(container.querySelector(".chat-worker-runtime-install-notice")).toBeNull();
});

it.each([
  ["buffering", "status", "OpenAI is reviewing this response for cyber safety."],
  ["blocked", "alert", "OpenAI blocked this response under its cyber policy."],
  ["fallback", "status", `OpenAI routed this response to ${model}.`],
  ["escalated", "status", `OpenAI declined this request; retried on ${model}.`],
  ["unavailable", "alert", `OpenAI declined this request; ${model} is not authorized.`],
] as const)("renders %s provider notice as plain text", (state, role, copy) => {
  const initial = {
    messages: [],
    providerPolicyNotice: { runId: "r", seq: 1, state, model: "m", fallbackModel: model },
  };
  const { container, publish } = publishedComposer(initial);
  const notice = container.querySelector(".chat-provider-policy-notice");
  expect(notice?.getAttribute("role")).toBe(role);
  expect(notice?.textContent).toContain(copy);
  expect(notice?.querySelector("img, button")).toBeNull();
  publishHistory(publish, initial, () => {
    expect(container.querySelector(".chat-provider-policy-notice")).toBe(notice);
    expect(notice?.getAttribute("role")).toBe(role);
  });
  publish({ messages: [] });
  flush();
  expect(container.querySelector(".chat-provider-policy-notice")).toBeNull();
});

it("offers an explicit discard action with the full warning when unsaved starts block recovery", () => {
  const discardAndReload = vi.fn();
  const retry = vi.fn();
  const { container } = publishedComposer({
    placementStartup: {
      ...failedPlacement(t("newSession.placementReloadBlocked")),
      discardAndReload,
    },
    onRetrySessionPlacementStartup: retry,
  });
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.querySelector("details")).toBeNull();
  expect(alert?.textContent).toContain("Recovery needs a reload. Unsaved starts will be lost.");
  const action = container.querySelector<HTMLButtonElement>(".chat-error__discard");
  expect(action?.textContent?.trim()).toBe("Discard unsaved starts and reload");
  expect(discardAndReload).not.toHaveBeenCalled();

  action?.click();

  expect(discardAndReload).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
});

it.each([
  [false, true],
  [false, false],
  [true, true],
  [true, false],
])("refreshes without retrying (contention=%s, connected=%s)", (contention, connected) => {
  const onRefresh = vi.fn(),
    onRetrySessionPlacementStartup = vi.fn();
  const diagnostic = contention ? `Busy\n${model}` : "The conversation changed.";
  const { container } = publishedComposer({
    connected,
    runError: {
      ...(contention ? { kind: "state_contention" as const } : {}),
      summary: diagnostic,
    },
    onRefresh,
    ...(contention ? { onRetrySessionPlacementStartup } : {}),
  });
  const notice = container.querySelector(".chat-error");
  if (contention) {
    expect(notice?.classList.contains("chat-composer-neighbor-card--warn")).toBe(true);
    expect(notice?.classList.contains("chat-composer-neighbor-card--danger")).toBe(false);
    expect(notice?.getAttribute("role")).toBe("status");
    const details = notice?.querySelector("details");
    expect(details).toMatchObject({ open: false });
    expect(details?.querySelector("strong")?.textContent).toBe(
      "OpenClaw is busy. Check status before trying again.",
    );
    expect(details?.querySelector("pre")?.textContent).toBe(diagnostic);
    expect(notice?.querySelector("img")).toBeNull();
  }
  const action = notice?.querySelector<HTMLButtonElement>(".chat-error__refresh");
  expect(action).toMatchObject({ disabled: !connected });
  expect(action?.textContent?.trim()).toBe(contention ? "Check status" : "Refresh");
  action?.click();
  expect(onRefresh).toHaveBeenCalledTimes(connected ? 1 : 0);
  if (contention) {
    expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
  }
});

it.each(["run", "placement"] as const)("preserves expanded diagnostics and focus (%s)", (kind) => {
  const diagnostic = "Synthetic failure\n  at workspace/session.ts:42";
  const initial: ComposerProps = {
    messages: [],
    runError: kind === "run" ? { summary: diagnostic } : undefined,
    placementStartup: kind === "placement" ? failedPlacement(diagnostic) : undefined,
  };
  const { container, publish } = publishedComposer(initial);
  const details = container.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  details.open = true;
  summary.focus();
  publishHistory(publish, initial, () => {
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(details.querySelector("pre")?.textContent).toBe(
      kind === "run" ? diagnostic : t("newSession.placementStartFailed", { error: diagnostic }),
    );
  });
});
