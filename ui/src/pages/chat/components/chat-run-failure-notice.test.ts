// @vitest-environment jsdom
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid as mountStatefulSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { projectChatSystemNotice } from "../chat-system-notice.ts";
import { renderChatComposerNotices } from "../chat-view-notices.tsx";
import { ChatNotice } from "./chat-notice-view.tsx";
import { nativeRows } from "./chat-transcript-rows.ts";

let container: HTMLDivElement;
let noticeView: { update: (props: Parameters<typeof ChatNotice>[0]) => void } | undefined;
const query = (selector: string) => container.querySelector<HTMLElement>(selector);
const part = (name: string) => query(`.chat-run-failure__${name}`);
const retry = () => query(".chat-run-failure__retry")?.click();
async function copy(summary: string) {
  query('button[aria-label="Copy error"]')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(summary);
}
const failure = (summary: string) => ({
  kind: "notice" as const,
  key: "failure",
  label: "",
  text: "",
  timestamp: 1,
  runError: { runId: "run-a", summary },
});
function drawNotice(
  item: Parameters<typeof ChatNotice>[0]["item"],
  recovery?: Parameters<typeof ChatNotice>[0]["recovery"],
) {
  const props: Parameters<typeof ChatNotice>[0] = { item, recovery };
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
  container.remove();
  await Promise.resolve();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("commits a cached failure summary with its transcript row", () => {
  mountStatefulSolid(nativeRows.notice, { item: failure("Cached failure details") }, container);
  expect(container.querySelector('[data-chat-row-key="failure"]')).not.toBeNull();
  expect(container.querySelector(".chat-run-failure__log")?.textContent).toBe(
    "Cached failure details",
  );
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
  drawNotice(item, { failureActionsRunId: "run-a", onRetryRun: onRetry });
  expect(container.textContent).toContain("Couldn’t finish this reply");
  expect(container.textContent).not.toContain("⚠");
  expect(part("icon svg")).not.toBeNull();
  expect(query("details")).toBeNull();
  expect(container.textContent).not.toContain("Change model");
  expect(part("summary")?.textContent).toBe(
    "Automatic recovery has stopped. Check any completed work before trying again.",
  );
  expect(part("log")?.textContent).toBe(
    "The AI service needs a short break. Please try again in a few minutes.",
  );
  await copy(summary);
  retry();
  expect(onRetry).toHaveBeenCalledExactlyOnceWith("run-a");
  for (const runId of ["run-a", "run-b"]) {
    const view = mountSolid(() =>
      renderChatComposerNotices({ messages: [message], runError: { runId, summary } }),
    );
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-error") === null).toBe(runId === "run-a"),
    );
  }
});

it("updates text and callbacks without closing the open details", async () => {
  const onRetry = vi.fn();
  const item = failure("First failure\nFirst details");
  drawNotice(item, { failureActionsRunId: "run-a", onRetryRun: onRetry });
  const host = query("openclaw-chat-run-failure-notice");
  expect(part("summary")?.textContent).toBe(
    "First failure Automatic recovery has stopped. Check any completed work before trying again.",
  );
  expect(part("log")?.textContent).toBe("First failure\nFirst details");
  part("toggle")?.click();
  expect(part("toggle")?.getAttribute("aria-expanded")).toBe("true");

  const nextRetry = vi.fn();
  const detail = `${"Long failure ".repeat(30)}\nUpdated details`;
  const summary = `⚠️ ${detail}`;
  drawNotice(
    { ...item, runError: { runId: "run-a", summary } },
    { failureActionsRunId: "run-a", onRetryRun: nextRetry },
  );
  expect(query("openclaw-chat-run-failure-notice")).toBe(host);
  expect(part("toggle")?.getAttribute("aria-expanded")).toBe("true");
  expect(part("summary")?.textContent).toBe(
    "Automatic recovery has stopped. Check any completed work before trying again.",
  );
  expect(part("log")?.textContent).toBe(detail);
  retry();
  expect(onRetry).not.toHaveBeenCalled();
  expect(nextRetry).toHaveBeenCalledExactlyOnceWith("run-a");
  await copy(summary);
});

it.each([
  { failureActionsRunId: "run-b" },
  { failureActionsRunId: "run-a", runActive: true },
  { failureActionsRunId: "run-a", runWorking: true },
])("removes recovery actions when the run is no longer eligible: %j", async (recovery) => {
  const item = failure("Failure details");
  const actions = { onRetryRun: vi.fn() };
  drawNotice(item, { failureActionsRunId: "run-a", ...actions });
  expect(query(".chat-run-failure__retry")).not.toBeNull();
  drawNotice(item, { ...recovery, ...actions });
  expect(query(".chat-run-failure__retry")).toBeNull();
  expect(query('button[aria-label="Copy error"]')).not.toBeNull();
});

it("keeps ordinary assistant warning text as authored content", () => {
  const item = {
    kind: "message" as const,
    key: "text",
    message: { role: "assistant", content: "⚠️ A warning written by the assistant" },
  };
  expect(projectChatSystemNotice(item)).toEqual([item]);
});

it("shows a repeat count only for repeated failures", () => {
  const item = { ...failure("Rate-limit recovery stopped"), repeatCount: 3 };
  drawNotice(item);
  expect(part("repeat")?.textContent).toBe("· 3 times");
  for (const repeatCount of [1, undefined]) {
    drawNotice({ ...item, repeatCount });
    expect(part("repeat")).toBeNull();
  }
});

it("names a provider's billing problem and sends its fix to Models, not another attempt", () => {
  const navigate = vi.fn<ApplicationContext["navigate"]>();
  const onRetryRun = vi.fn<(runId: string) => void>();
  const draw = (failoverReason: string) =>
    mountSolid(
      () =>
        createComponent(ApplicationProvider, {
          value: { navigate } as unknown as ApplicationContext,
          get children() {
            return createComponent(ChatNotice, {
              item: {
                ...failure("Provider error"),
                runError: {
                  runId: "run-a",
                  summary: "Provider error",
                  cause: { provider: "openrouter", failoverReason },
                },
              },
              recovery: { failureActionsRunId: "run-a", onRetryRun },
            });
          },
        }),
      { container },
    );
  const billing = draw("billing");
  expect(part("title")?.textContent).toBe("OpenRouter reports a billing problem");
  const [openModels, tryAgain] = container.querySelectorAll<HTMLButtonElement>(
    ".chat-run-failure__retry",
  );
  expect(openModels?.textContent).toBe("Open Models");
  expect(openModels?.classList.contains("primary")).toBe(true);
  expect(tryAgain?.classList.contains("primary")).toBe(false);
  openModels?.click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("model-providers", {
    search: "?provider=openrouter",
  });
  expect(onRetryRun).not.toHaveBeenCalled();
  billing.unmount();

  // A failure another attempt can fix keeps its generic title and Try again.
  draw("overloaded");
  expect(part("title")?.textContent).toBe("Couldn’t finish this reply");
  expect(container.querySelectorAll(".chat-run-failure__retry")).toHaveLength(1);
  expect(query(".chat-run-failure__retry")?.classList.contains("primary")).toBe(true);
});
