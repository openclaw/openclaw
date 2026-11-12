import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { ChatRunFailureNotice } from "./chat-run-failure-notice.tsx";
import "../../../styles/chat/run-failure.css";
import "../../../styles/base.css";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("dir");
});

const trace = ["First failure", ...Array.from({ length: 40 }, (_, k) => `attempt ${k + 1}`)].join(
  "\n",
);

function mount(height: number, lineTop: number) {
  const view = render(() => (
    <div
      class="chat-thread"
      style={{ position: "fixed", inset: "0 0 auto", height: `${height}px`, overflow: "auto" }}
    >
      <div style={{ height: `${lineTop}px` }} />
      <ChatRunFailureNotice summary={trace} onRetry={() => undefined} />
      <div data-next style={{ height: "40px" }} />
    </div>
  ));
  const toggle = view.container.querySelector<HTMLButtonElement>(".chat-run-failure__toggle")!;
  const panel = view.container.querySelector<HTMLElement>(".chat-run-failure__panel")!;
  const line = view.container.querySelector<HTMLElement>(".chat-run-failure")!;
  return { view, toggle, panel, line };
}

it("opens details in the conversation and restores the cause when closed", async () => {
  const { view, toggle, panel } = mount(700, 40);
  const next = view.container.querySelector<HTMLElement>("[data-next]")!;
  const summary = view.container.querySelector<HTMLElement>(".chat-run-failure__summary")!;
  const closedTop = next.getBoundingClientRect().top;
  await userEvent.click(toggle);
  await expect.poll(() => getComputedStyle(panel).visibility).toBe("visible");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
  await expect.poll(() => next.getBoundingClientRect().top).toBeGreaterThan(closedTop);
  expect(getComputedStyle(summary.parentElement!.parentElement!).visibility).toBe("hidden");
  expect(panel.inert).toBe(false);
  await userEvent.click(toggle);
  await expect.poll(() => getComputedStyle(panel).visibility).toBe("hidden");
  await expect.poll(() => next.getBoundingClientRect().top).toBe(closedTop);
  expect(panel.inert).toBe(true);
  expect(getComputedStyle(summary.parentElement!.parentElement!).visibility).toBe("visible");
});

it("keeps the card in view as its details grow at the end of the transcript", async () => {
  const { view, toggle, line } = mount(420, 360);
  const thread = view.container.querySelector<HTMLElement>(".chat-thread")!;
  await userEvent.click(toggle);
  await expect
    .poll(() => line.getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(thread.getBoundingClientRect().bottom);
  expect(thread.scrollTop).toBeGreaterThan(0);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

it("fades each scrollable edge of the log and clears the fade at that edge", async () => {
  const { view, toggle, panel } = mount(700, 40);
  const log = view.container.querySelector<HTMLElement>(".chat-run-failure__log")!;
  await userEvent.click(toggle);
  await expect.poll(() => getComputedStyle(panel).visibility).toBe("visible");
  await expect.poll(() => log.hasAttribute("data-fade-bottom")).toBe(true);
  expect(log.hasAttribute("data-fade-top")).toBe(false);
  log.scrollTop = 40;
  await expect.poll(() => log.hasAttribute("data-fade-top")).toBe(true);
  expect(log.hasAttribute("data-fade-bottom")).toBe(true);
  log.scrollTop = log.scrollHeight;
  await expect.poll(() => log.hasAttribute("data-fade-bottom")).toBe(false);
  expect(log.hasAttribute("data-fade-top")).toBe(true);
});

it("keeps the log left to right and isolates the error's sentence in a right-to-left locale", async () => {
  document.documentElement.dir = "rtl";
  const { view, toggle, panel } = mount(700, 40);
  await userEvent.click(toggle);
  await expect.poll(() => getComputedStyle(panel).visibility).toBe("visible");
  const part = (selector: string) => view.container.querySelector<HTMLElement>(selector)!;
  const log = part(".chat-run-failure__log");
  const well = part(".chat-run-failure__well").getBoundingClientRect();
  const copy = part(".chat-run-failure__copy").getBoundingClientRect();
  const summary = part(".chat-run-failure__summary");
  expect(getComputedStyle(log).direction).toBe("ltr");
  expect(well.right - copy.right).toBeLessThan(copy.left - well.left);
  expect(getComputedStyle(summary).direction).toBe("rtl");
  expect(summary.querySelector("bdi")?.textContent).toBe("First failure");
});
