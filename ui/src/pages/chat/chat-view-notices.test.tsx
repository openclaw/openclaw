/* @vitest-environment jsdom */

import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderChatComposerNotices, renderChatTopbarNotices } from "./chat-view-notices.tsx";
import { ChatConversationMobile } from "./components/chat-conversation-presentation.ts";

const model = "<img src=x onerror=alert(1)>";
type ComposerProps = Parameters<typeof renderChatComposerNotices>[0];
type TopbarProps = Parameters<typeof renderChatTopbarNotices>[0];

function publishedNotices<P extends object>(Notices: (props: P) => JSX.Element, initial: P) {
  const [props, publish] = createSignal<P>(() => initial);
  return { ...mountSolid(() => <Notices {...props()} />), publish };
}
const publishedComposer = (initial: Omit<ComposerProps, "messages">, mobile = false) =>
  publishedNotices<ComposerProps>(
    (props) => (
      <ChatConversationMobile value={() => mobile}>
        {renderChatComposerNotices(props)}
      </ChatConversationMobile>
    ),
    { messages: [], ...initial },
  );
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

it.each([
  ["run", false],
  ["run", true],
  ["placement", false],
] as const)("preserves expanded diagnostics and focus (%s, mobile=%s)", (kind, mobile) => {
  const diagnostic = "Synthetic failure\n  at workspace/session.ts:42";
  const initial: ComposerProps = {
    messages: [],
    runError: kind === "run" ? { summary: diagnostic } : undefined,
    placementStartup: kind === "placement" ? failedPlacement(diagnostic) : undefined,
  };
  const { container, publish } = publishedComposer(initial, mobile);
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

it.each(["chatgpt_business_usage_limit", "chatgpt_consumer_usage_limit"] as const)(
  "keeps %s recovery beside a transcript error and resets dismissal for a new run",
  (kind) => {
    const restoreDialog = installDialogPolyfill();
    const initial: ComposerProps = {
      sessionKey: "agent:main:business-limit",
      messages: [{ openclawRunError: { runId: "run-1", summary: "Usage limit reached" } }],
      runError: {
        kind,
        runId: "run-1",
        summary: "Usage limit reached",
      },
    };
    const view = publishedNotices(renderChatComposerNotices, initial);
    try {
      flush();
      expect(view.container.querySelector("dialog")?.open).toBe(true);
      view.getByRole("button", { name: "Close" }).click();
      flush();
      publishHistory(view.publish, initial, () => {
        expect(view.container.querySelector("dialog")?.open).toBe(false);
      });
      view.publish({ ...initial, runError: { ...initial.runError!, runId: "run-2" } });
      flush();
      expect(view.container.querySelector("dialog")?.open).toBe(true);
      view.publish({ messages: [] });
      flush();
      expect(view.container.querySelector("dialog")).toBeNull();
    } finally {
      view.unmount();
      restoreDialog();
    }
  },
);

it.each(["refresh", "details", "message"] as const)(
  "keeps available mobile error actions and diagnostics (%s)",
  (variant) => {
    const onRefresh = vi.fn();
    const diagnostic =
      variant === "message" ? "Stopped." : "Request interrupted.\nPlease check the conversation.";
    const { container } = publishedComposer(
      {
        connected: true,
        runError: { kind: "stop", summary: diagnostic },
        onRefresh: variant === "refresh" ? onRefresh : undefined,
      },
      true,
    );
    const notice = container.querySelector(".chat-error")!;
    expect(notice.textContent).toContain(
      diagnostic === "Stopped." ? diagnostic : "Request interrupted.",
    );
    expect(notice.querySelector(".chat-error__dismiss")).toBeNull();
    const details = notice.querySelector("details");
    if (variant === "message") {
      expect(details).toBeNull();
      expect(notice.querySelector("button")).toBeNull();
      return;
    }
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary .chat-copy-btn")).toBeNull();
    details!.open = true;
    expect(details?.querySelector("pre")?.textContent).toBe(diagnostic);
    expect(details?.querySelector(".chat-copy-btn")?.getAttribute("aria-label")).toBe(
      t("chat.copyError"),
    );
    const refresh = notice.querySelector<HTMLButtonElement>(".chat-error__refresh");
    if (variant === "refresh") {
      refresh!.click();
      expect(onRefresh).toHaveBeenCalledOnce();
      expect(details?.open).toBe(true);
    } else {
      expect(refresh).toBeNull();
    }
  },
);
