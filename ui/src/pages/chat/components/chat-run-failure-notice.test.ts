// @vitest-environment jsdom
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectChatSystemNotice } from "../chat-system-notice.ts";
import { renderChatComposerNotices } from "../chat-view-notices.ts";
import { renderChatNotice } from "./chat-divider.ts";

let container: HTMLDivElement;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  container = document.body.appendChild(document.createElement("div"));
});

afterEach(async () => {
  render(nothing, container);
  container.remove();
  // The bridge defers disposal one microtask to preserve synchronous reparenting.
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
  const onChangeModel = vi.fn();
  render(
    renderChatNotice(item, undefined, {
      failureActionsRunId: "run-a",
      onRetryRun: onRetry,
      onChangeFailureModel: onChangeModel,
    }),
    container,
  );
  await container.querySelector("openclaw-chat-run-failure-notice")?.updateComplete;
  expect(container.querySelectorAll(".chat-run-failure")).toHaveLength(1);
  expect(container.textContent).toContain("Unable to finish this reply");
  expect(container.textContent).not.toContain("⚠");
  expect(container.querySelector(".chat-run-failure__icon svg")).not.toBeNull();
  expect(container.querySelector("details")?.open).toBe(false);
  container.querySelector("summary")?.click();
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector("pre")?.textContent).toBe(
    "The AI service needs a short break. Please try again in a few minutes.",
  );
  container.querySelector<HTMLButtonElement>('button[aria-label="Copy error"]')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(summary);
  const buttons = [...container.querySelectorAll("button")];
  buttons.find((b) => b.textContent?.includes("Try again"))?.click();
  buttons.find((b) => b.textContent?.includes("Change model"))?.click();
  expect(onRetry).toHaveBeenCalledExactlyOnceWith("run-a");
  expect(onChangeModel).toHaveBeenCalledExactlyOnceWith("run-a");
  render(
    renderChatComposerNotices({ messages: [message], runError: { runId: "run-a", summary } }),
    container,
  );
  expect(container.querySelector(".chat-error")).toBeNull();
  render(
    renderChatComposerNotices({ messages: [message], runError: { runId: "run-b", summary } }),
    container,
  );
  expect(container.querySelector(".chat-error")).not.toBeNull();
});

it("updates bridge text and callbacks without closing expanded details", async () => {
  const onRetry = vi.fn();
  const onChangeModel = vi.fn();
  const item = {
    kind: "notice" as const,
    key: "failure",
    label: "",
    text: "",
    timestamp: 1,
    runError: { runId: "run-a", summary: "First failure\nFirst details" },
  };
  render(
    renderChatNotice(item, undefined, {
      failureActionsRunId: "run-a",
      onRetryRun: onRetry,
      onChangeFailureModel: onChangeModel,
    }),
    container,
  );
  const host = container.querySelector("openclaw-chat-run-failure-notice");
  await host?.updateComplete;
  expect(container.querySelector(".chat-run-failure__summary")?.textContent).toBe("First failure");
  container.querySelector("summary")?.click();

  const nextRetry = vi.fn();
  const nextChangeModel = vi.fn();
  const detail = `${"Long failure ".repeat(30)}\nUpdated details`;
  const summary = `⚠️ ${detail}`;
  render(
    renderChatNotice({ ...item, runError: { runId: "run-a", summary } }, undefined, {
      failureActionsRunId: "run-a",
      onRetryRun: nextRetry,
      onChangeFailureModel: nextChangeModel,
    }),
    container,
  );
  await host?.updateComplete;
  expect(container.querySelector("openclaw-chat-run-failure-notice")).toBe(host);
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector(".chat-run-failure__summary")?.textContent).toBe(
    "Automatic recovery has stopped. Check any completed work before trying again.",
  );
  expect(container.querySelector("pre")?.textContent).toBe(detail);
  const buttons = [...container.querySelectorAll("button")];
  buttons.find((button) => button.textContent?.includes("Try again"))?.click();
  buttons.find((button) => button.textContent?.includes("Change model"))?.click();
  expect(onRetry).not.toHaveBeenCalled();
  expect(onChangeModel).not.toHaveBeenCalled();
  expect(nextRetry).toHaveBeenCalledExactlyOnceWith("run-a");
  expect(nextChangeModel).toHaveBeenCalledExactlyOnceWith("run-a");
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
  const actions = { onRetryRun: vi.fn(), onChangeFailureModel: vi.fn() };
  render(
    renderChatNotice(item, undefined, { failureActionsRunId: "run-a", ...actions }),
    container,
  );
  const host = container.querySelector("openclaw-chat-run-failure-notice");
  await host?.updateComplete;
  expect(container.querySelectorAll(".chat-run-failure__actions button")).toHaveLength(2);
  render(renderChatNotice(item, undefined, { ...recovery, ...actions }), container);
  await host?.updateComplete;
  expect(container.querySelectorAll(".chat-run-failure__actions button")).toHaveLength(0);
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
