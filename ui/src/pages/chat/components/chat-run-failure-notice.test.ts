// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid as mountStatefulSolid } from "../../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { projectChatSystemNotice } from "../chat-system-notice.ts";
import { renderChatComposerNotices } from "../chat-view-notices.tsx";
import { ChatNotice } from "./chat-divider.tsx";

let container: HTMLDivElement;
let noticeView: { update: (props: Parameters<typeof ChatNotice>[0]) => void } | undefined;
function drawNotice(
  item: Parameters<typeof ChatNotice>[0]["item"],
  onPermissionRetry?: Parameters<typeof ChatNotice>[0]["onPermissionRetry"],
  recovery?: Parameters<typeof ChatNotice>[0]["recovery"],
) {
  const props: Parameters<typeof ChatNotice>[0] = { item, onPermissionRetry, recovery };
  if (noticeView) {
    noticeView.update(props);
  } else {
    noticeView = mountStatefulSolid(ChatNotice, props, container);
  }
}
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  noticeView = undefined;
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  container = document.body.appendChild(document.createElement("div"));
});

afterEach(async () => {
  cleanupSolid();
  container.remove();
  await Promise.resolve();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("replaces the canonical failed run row with one line-icon notice and explicit actions", async () => {
  const summary = "⚠️ The AI service needs a short break. Please try again in a few minutes.";
  const message = {
    role: "custom",
    content: summary,
    timestamp: 1,
    openclawRunError: { runId: "run-a", summary },
  };
  const items = projectChatSystemNotice({ kind: "message", key: "failure", message });
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item?.kind !== "notice") {
    throw new Error("Expected failure notice");
  }
  const onRetry = vi.fn();
  drawNotice(item, undefined, {
    failureActionsRunId: "run-a",
    onRetryRun: onRetry,
  });
  flush();
  expect(container.querySelectorAll(".chat-run-failure")).toHaveLength(1);
  expect(container.textContent).toContain("Unable to finish this reply");
  expect(container.textContent).not.toContain("⚠");
  expect(container.querySelector(".chat-run-failure__icon svg")).not.toBeNull();
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).not.toContain("Change model");
  expect(container.querySelector(".chat-run-failure__summary")?.textContent).toBe(
    "The AI service needs a short break. Please try again in a few minutes.",
  );
  container.querySelector<HTMLButtonElement>('button[aria-label="Copy error"]')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(summary);
  const buttons = [...container.querySelectorAll("button")];
  buttons.find((b) => b.textContent?.includes("Try again"))?.click();
  expect(onRetry).toHaveBeenCalledExactlyOnceWith("run-a");
  const matchingFailure = mountSolid(() =>
    renderChatComposerNotices({ messages: [message], runError: { runId: "run-a", summary } }),
  );
  await waitForSolid(() =>
    expect(matchingFailure.container.querySelector(".chat-error")).toBeNull(),
  );
  const otherFailure = mountSolid(() =>
    renderChatComposerNotices({ messages: [message], runError: { runId: "run-b", summary } }),
  );
  await waitForSolid(() =>
    expect(otherFailure.container.querySelector(".chat-error")).not.toBeNull(),
  );
});

it("updates text and callbacks without closing expanded details", async () => {
  const onRetry = vi.fn();
  const item = {
    kind: "notice" as const,
    key: "failure",
    label: "",
    text: "",
    timestamp: 1,
    runError: { runId: "run-a", summary: "First failure\nFirst details" },
  };
  drawNotice(item, undefined, {
    failureActionsRunId: "run-a",
    onRetryRun: onRetry,
  });
  const host = container.querySelector("openclaw-chat-run-failure-notice");
  flush();
  expect(container.querySelector(".chat-run-failure__summary")?.textContent).toBe("First failure");
  container.querySelector("summary")?.click();

  const nextRetry = vi.fn();
  const detail = `${"Long failure ".repeat(30)}\nUpdated details`;
  const summary = `⚠️ ${detail}`;
  drawNotice({ ...item, runError: { runId: "run-a", summary } }, undefined, {
    failureActionsRunId: "run-a",
    onRetryRun: nextRetry,
  });
  flush();
  expect(container.querySelector("openclaw-chat-run-failure-notice")).toBe(host);
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector(".chat-run-failure__summary")?.textContent).toBe(
    "Automatic recovery has stopped. Check any completed work before trying again.",
  );
  expect(container.querySelector("pre")?.textContent).toBe(detail);
  const buttons = [...container.querySelectorAll("button")];
  buttons.find((button) => button.textContent?.includes("Try again"))?.click();
  expect(onRetry).not.toHaveBeenCalled();
  expect(nextRetry).toHaveBeenCalledExactlyOnceWith("run-a");
  container.querySelector<HTMLButtonElement>('button[aria-label="Copy error"]')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(summary);
});

it.each([
  { failureActionsRunId: "run-b" },
  { failureActionsRunId: "run-a", runActive: true },
  { failureActionsRunId: "run-a", runWorking: true },
])("removes recovery actions when the run is no longer eligible: %j", async (recovery) => {
  const item = {
    kind: "notice" as const,
    key: "failure",
    label: "",
    text: "",
    timestamp: 1,
    runError: { runId: "run-a", summary: "Failure details" },
  };
  const actions = { onRetryRun: vi.fn() };
  drawNotice(item, undefined, { failureActionsRunId: "run-a", ...actions });
  flush();
  expect(container.querySelectorAll(".chat-run-failure__header button")).toHaveLength(2);
  drawNotice(item, undefined, { ...recovery, ...actions });
  flush();
  expect(container.querySelectorAll(".chat-run-failure__header button")).toHaveLength(1);
  expect(container.querySelector('button[aria-label="Copy error"]')).not.toBeNull();
});

it("keeps ordinary assistant warning text as authored content", () => {
  const item = {
    kind: "message" as const,
    key: "text",
    message: { role: "assistant", content: "⚠️ A warning written by the assistant" },
  };
  expect(projectChatSystemNotice(item)).toEqual([item]);
});
