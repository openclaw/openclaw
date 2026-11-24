/* @vitest-environment jsdom */

import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { renderChatComposerNotices, renderChatTopbarNotices } from "./chat-view-notices.tsx";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  renderChatInto,
  renderChatView,
  requireElement,
  waitForElement,
} from "./chat-view.test-helpers.ts";
import { ChatConversationMobile } from "./components/chat-conversation-presentation.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import {
  workspaceConflictPathForDisplay,
  workspaceResultConflictFromTranscript,
} from "./workspace-conflict.ts";

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
      providerPolicyNotice: initial.providerPolicyNotice && { ...initial.providerPolicyNotice },
    });
    flush();
    check();
  }
}

it("replaces the visible error when a different run fails", async () => {
  const { getByRole, publish } = publishedComposer({ runError: { summary: "First failure" } });
  await waitForSolid(() => expect(getByRole("alert").textContent).toBe("First failure"));
  publish({ messages: [], runError: { summary: "Second failure\nAdditional context" } });
  await waitForSolid(() =>
    expect(getByRole("alert").textContent).toBe("Second failure\nAdditional context"),
  );
});
it("preserves caller-owned recovery instructions in request notices", async () => {
  const error = "Session is busy; wait for the current run to finish.";
  const { container } = publishedNotices<TopbarProps>(renderChatTopbarNotices, { error });
  await waitForSolid(() => {
    expect(container.querySelector(".chat-error .app-toast__message")?.textContent).toBe(error);
    expect(container.querySelector("details")).toBeNull();
  });
});
const failedPlacement = (error: string) => ({
  sessionKey: "agent:main:failed-start",
  phase: "failed" as const,
  startedAt: 1,
  retryable: false,
  error,
});

afterEach(() => document.body.replaceChildren());

it.each(["transferring", "installing"] as const)("shows %s worker progress", async (phase) => {
  const installing = phase === "installing";
  const title = installing
    ? "Preparing this device…"
    : "Preparing this device · 25 MB of 100 MB (25%)";
  const body = installing
    ? "Installing the update on this device."
    : "Transferring the update to this device: 25 MB of 100 MB (25%). The next reply starts when it finishes.";
  const { container, publish } = publishedNotices<TopbarProps>(renderChatTopbarNotices, {
    workerRuntimeInstall: {
      phase,
      transferredBytes: (installing ? 100 : 25) * 1_024 * 1_024,
      totalBytes: 100 * 1_024 * 1_024,
      startedAtMs: 1,
      updatedAtMs: 2,
    },
  });
  await waitForSolid(() =>
    expect(container.querySelector(".chat-worker-runtime-install-notice")).not.toBeNull(),
  );
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
] as const)("renders %s provider notice as plain text", async (state, role, copy) => {
  const initial = {
    messages: [],
    providerPolicyNotice: { runId: "r", seq: 1, state, model: "m", fallbackModel: model },
  };
  const { container, publish } = publishedComposer(initial);
  await waitForSolid(() =>
    expect(container.querySelector(".chat-provider-policy-notice")).not.toBeNull(),
  );
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

it("offers an explicit discard action with the full warning when unsaved starts block recovery", async () => {
  const discardAndReload = vi.fn();
  const retry = vi.fn();
  const { container } = publishedComposer({
    placementStartup: {
      ...failedPlacement("Recovery needs a reload. Unsaved starts will be lost."),
      discardAndReload,
    },
    onRetrySessionPlacementStartup: retry,
  });
  await waitForSolid(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
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
])("refreshes without retrying (contention=%s, connected=%s)", async (contention, connected) => {
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
  await waitForSolid(() => expect(container.querySelector(".chat-error")).not.toBeNull());
  const notice = container.querySelector(".chat-error");
  if (contention) {
    expect(notice?.classList.contains("chat-composer-neighbor-card--warn")).toBe(true);
    expect(notice?.classList.contains("chat-composer-neighbor-card--danger")).toBe(false);
    expect(notice?.querySelector('[role="status"]')?.textContent).toBe(diagnostic);
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

it("preserves an expanded startup diagnostic and focus across history updates", async () => {
  const diagnostic = "Synthetic failure\n  at workspace/session.ts:42";
  const initial = { messages: [], placementStartup: failedPlacement(diagnostic) };
  const { container, publish } = publishedComposer(initial);
  const details = await waitForElement(container, "details", "startup error details");
  const toggle = requireElement(details, "summary", "startup error toggle") as HTMLElement;
  toggle.click();
  toggle.focus();
  publishHistory(publish, initial, () => {
    expect(container.querySelector("details")).toBe(details);
    expect(details.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(details.querySelector(".lazy-view-error__detail")?.textContent).toBe(
      t("newSession.placementStartFailed", { error: diagnostic }),
    );
  });
});

it.each(["chatgpt_business_usage_limit", "chatgpt_consumer_usage_limit"] as const)(
  "keeps %s recovery beside a transcript error and resets dismissal for a new run",
  async (kind) => {
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
      await waitForSolid(() => expect(view.container.querySelector("dialog")?.open).toBe(true));
      view.getByRole("button", { name: "Close" }).click();
      flush();
      publishHistory(view.publish, initial, () => {
        expect(view.container.querySelector("dialog")?.open).toBe(false);
      });
      view.publish({ ...initial, runError: { ...initial.runError!, runId: "run-2" } });
      await waitForSolid(() => expect(view.container.querySelector("dialog")?.open).toBe(true));
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
  async (variant) => {
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
    await waitForSolid(() => expect(container.querySelector(".chat-error")).not.toBeNull());
    const notice = container.querySelector(".chat-error")!;
    expect(notice.textContent).toContain(
      diagnostic === "Stopped." ? diagnostic : "Request interrupted.",
    );
    expect(notice.querySelector(".app-toast__dismiss")).toBeNull();
    const details = notice.querySelector("details");
    if (variant === "message") {
      expect(details).toBeNull();
    } else {
      expect(details?.open).toBe(false);
      expect(details?.querySelector("summary .chat-copy-btn")).toBeNull();
      details!.open = true;
      expect(details?.querySelector(".lazy-view-error__detail")?.textContent).toBe(diagnostic);
      expect(details?.querySelector(".chat-copy-btn")?.getAttribute("aria-label")).toBe(
        t("chat.copyError"),
      );
    }
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

describe("chat view notice integration", () => {
  beforeEach(async () => {
    onTestFinished(installChatComposerPickerDismissal(document));
    installTranscriptDomMocks();
    // These assertions cover presentation; await the lazy module as fixture setup.
    await import("./chat-view-notices-content.tsx");
  });

  afterEach(() => {
    resetChatViewState();
    resetTranscriptTestDom();
  });

  describe("chat run error", () => {
    it("renders the complete redacted run error as plain text", async () => {
      const diagnostic =
        "⚠️ Error: gateway disconnected near 🧭\n  indented detail\n<img src=x onerror=alert(1)>\npassword=synthetic-password";
      const container = renderChatView({ runError: { summary: diagnostic } });
      const message = await waitForElement(
        container,
        '.chat-reply-notice [role="alert"]',
        "chat run error",
      );
      expect(message.textContent).toBe(
        "Error: gateway disconnected near 🧭\n  indented detail\n<img src=x onerror=alert(1)>\npassword=[redacted]",
      );
      expect(message.querySelector("img")).toBeNull();
      expect(message.closest(".agent-chat__composer-notices")).not.toBeNull();
    });

    it("keeps the request diagnostic collapsed, copyable, and dismissible", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const diagnostic = "⚠️ Request failed near 🧭\n  additional detail";
      const onDismissError = vi.fn();
      const container = renderChatView({ error: diagnostic, onDismissError });
      const alert = await waitForElement(
        container,
        ".chat-topbar-notices .chat-error",
        "chat request error",
      );
      const details = requireElement(alert, "details", "request disclosure");
      expect(details.hasAttribute("open")).toBe(false);
      const toggle = requireElement(
        details,
        "summary",
        "request disclosure control",
      ) as HTMLElement;
      toggle.click();
      expect(details.hasAttribute("open")).toBe(true);
      const copy = requireElement(
        details,
        '[aria-label="Copy error"]',
        "copy error",
      ) as HTMLButtonElement;
      copy.click();
      await waitForFast(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(diagnostic));
      expect(details.hasAttribute("open")).toBe(true);
      const dismiss = requireElement(
        alert,
        '[aria-label="Dismiss error"]',
        "dismiss error",
      ) as HTMLButtonElement;
      dismiss.click();
      expect(onDismissError).toHaveBeenCalledOnce();
    });

    it.each([true])("keeps startup Retry owned by retryable=%s", async (retryable) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const onRetrySessionPlacementStartup = vi.fn();
      const container = renderChatView({
        placementStartup: {
          sessionKey: "agent:main:startup",
          targetKind: "profile",
          phase: "failed",
          startedAt: 1,
          error: "⚠️ Provisioning failed\n  Final diagnostic line  ",
          retryable,
        },
        onRetrySessionPlacementStartup,
      });
      const alert = await waitForElement(container, ".chat-error", "startup error");
      expect(
        requireElement(alert, ".lazy-view-error__detail", "startup diagnostic").textContent,
      ).toBe(
        "Couldn’t start this session. Retry setup.  Provisioning failed\n  Final diagnostic line  ",
      );
      expect(alert.textContent).not.toContain("⚠");
      const details = requireElement(alert, "details", "startup disclosure");
      expect(requireElement(details, "summary", "startup header").textContent).toContain(
        "Show details",
      );
      expect(
        requireElement(details, ".lazy-view-error__detail", "startup diagnostic").getAttribute(
          "aria-label",
        ),
      ).toBe("Error details");
      const copy = details.querySelector<HTMLButtonElement>('[aria-label="Copy error"]');
      expect(copy).not.toBeNull();
      copy?.click();
      await waitForFast(() =>
        expect(writeText).toHaveBeenCalledWith(
          "Couldn’t start this session. Retry setup. ⚠️ Provisioning failed\n  Final diagnostic line  ",
        ),
      );
      expect(details.hasAttribute("open")).toBe(false);
      alert.querySelector<HTMLElement>("summary")?.click();
      expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
      const retry = Array.from(alert.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(Boolean(retry)).toBe(retryable);
      retry?.click();
      expect(onRetrySessionPlacementStartup).toHaveBeenCalledTimes(retryable ? 1 : 0);
    });
  });

  describe("cloud workspace conflict notice", () => {
    const conflict = {
      paths: [
        "src/[path]-1.ts",
        "src/path-2.ts",
        "src/path-3.ts",
        "src/path-4.ts",
        "src/path-5.ts",
        "src/path-6.ts",
      ],
      stagedResultRef: "refs/openclaw/worker-results/claim-123",
      totalCount: 9,
    };

    it("bounds conflict guidance and copies the selected path recovery command", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const onDismissWorkspaceConflict = vi.fn();
      const container = renderChatView({
        workspaceConflict: conflict,
        onDismissWorkspaceConflict,
      });

      const notice = await waitForElement(container, ".chat-workspace-conflict-notice");
      expect(notice.closest(".agent-chat__composer-notices")).not.toBeNull();
      expect(notice.textContent).toContain("9 cloud workspace conflicts");
      expect(notice.querySelectorAll(".chat-workspace-conflict-paths li")).toHaveLength(5);
      expect(notice.textContent).toContain("+4 more paths");
      expect(notice.textContent).toContain(conflict.stagedResultRef);
      expect(notice.textContent).toContain("Git Bash on Windows");
      expect(notice.textContent).toContain("file/directory conflict");
      expect(notice.textContent).toContain("cloud deleted it");
      expect(notice.textContent).toContain("staged ref is missing");

      const commands = [...notice.querySelectorAll(".chat-workspace-conflict-commands code")].map(
        (element) => element.textContent,
      );
      expect(commands).toEqual([
        "git show 'refs/openclaw/worker-results/claim-123:src/[path]-1.ts'",
        "git checkout 'refs/openclaw/worker-results/claim-123' -- ':(top,literal)src/[path]-1.ts'",
      ]);
      expect(
        notice.querySelector<HTMLButtonElement>('[aria-label="Copy cloud inspect command"]'),
      ).toBeInstanceOf(HTMLButtonElement);
      expect(
        notice.querySelector<HTMLButtonElement>('[aria-label="Copy take-cloud command"]'),
      ).toBeInstanceOf(HTMLButtonElement);

      const rows = notice.querySelectorAll(".chat-workspace-conflict-paths li");
      rows[1]?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(
        "git checkout 'refs/openclaw/worker-results/claim-123' -- ':(top,literal)src/path-2.ts'",
      );

      notice
        .querySelector<HTMLButtonElement>('[aria-label="Dismiss workspace conflict notice"]')!
        .click();
      expect(onDismissWorkspaceConflict).toHaveBeenCalledTimes(1);
    });

    it.each(["\u0085"])(
      "keeps terminal-control paths visible without building copyable commands (%j)",
      async (controlSequence) => {
        const entryPath = `src/${controlSequence}unsafe.ts`;
        const normalizedConflict = workspaceResultConflictFromTranscript({
          role: "custom",
          customType: "cloud-workspace-conflict",
          details: {
            paths: [entryPath],
            stagedResultRef: "refs/openclaw/worker-results/claim-unsafe",
          },
        });
        expect(normalizedConflict).toBeDefined();
        const container = renderChatView({ workspaceConflict: normalizedConflict });
        await waitForSolid(() =>
          expect(container.querySelector(".chat-workspace-conflict-paths code")?.textContent).toBe(
            workspaceConflictPathForDisplay(entryPath),
          ),
        );
        expect(container.querySelector(".chat-workspace-conflict-commands")).toBeNull();
        expect(container.textContent).toContain("will not build a copyable shell command");
      },
    );
  });

  describe("cloud worker disk-space notice", () => {
    it("updates persistent disk guidance and clears it after recovery", async () => {
      const container = createComposerContainer();
      renderChatInto(container, {
        diskSpace: { status: "warning", availableBytes: 400, totalBytes: 1_000, observedAtMs: 1 },
      });
      await waitForElement(container, ".chat-cloud-disk-space-notice", "disk-space notice");
      renderChatInto(container, {
        diskSpace: {
          status: "critical",
          availableBytes: 50 * 1024 * 1024,
          totalBytes: 10 * 1024 * 1024 * 1024,
          observedAtMs: 1_000,
        },
      });
      const notice = requireElement(
        container,
        ".chat-cloud-disk-space-notice",
        "disk-space notice",
      );
      expect(notice.getAttribute("role")).toBe("alert");
      expect(notice.textContent).toContain("Cloud session disk space is critically low");
      expect(notice.textContent).toContain("New writes may fail and stop the agent.");
      expect(notice.querySelector("svg")).not.toBeNull();
      expect(notice.querySelector("button")).toBeNull();
      expect(notice.closest(".chat-topbar-notices")).not.toBeNull();
      renderChatInto(container, {
        diskSpace: { status: "ok", availableBytes: 800, totalBytes: 1_000, observedAtMs: 2 },
      });
      expect(container.querySelector(".chat-cloud-disk-space-notice")).toBeNull();
    });
  });
});

it("offers a static issue form without including error text or diagnostics", async () => {
  const { container, publish } = publishedNotices<TopbarProps>(renderChatTopbarNotices, {
    error: "Synthetic private error ws://private.invalid/?token=secret session:private",
    errorDetail: { message: "Synthetic diagnostic", credential: "never-share-this" },
  });
  await waitForSolid(() => {
    const link = container.querySelector<HTMLAnchorElement>("a.report-issue-link");
    expect(link?.textContent).toBe("Report a bug");
    const url = new URL(link!.href);
    expect(url.origin + url.pathname).toBe("https://github.com/openclaw/openclaw/issues/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: "bug_report.yml",
      title: "[Bug]: Control UI: ",
    });
    expect(link?.rel).toBe("noopener noreferrer");
    expect(link?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(link?.target).toBe("_blank");
  });
  const destination = container.querySelector<HTMLAnchorElement>("a.report-issue-link")!.href;
  publish({ error: "Another synthetic error with private user content", errorDetail: undefined });
  await waitForSolid(() => {
    expect(container.querySelector<HTMLAnchorElement>("a.report-issue-link")?.href).toBe(
      destination,
    );
  });
});
