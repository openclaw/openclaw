import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { phase } from "../../../test-helpers/solid-menu.tsx";
import { ChatRunFailureNotice } from "./chat-run-failure-notice.tsx";
import "../../../styles/chat/run-failure.css";

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

it("opens out of flow without moving the conversation, then closes on Escape and outside click", async () => {
  const { view, toggle, panel } = mount(700, 40);
  const next = view.container.querySelector<HTMLElement>("[data-next]")!;
  const thread = view.container.querySelector<HTMLElement>(".chat-thread")!;
  const measure = () => [next.getBoundingClientRect().top, thread.scrollHeight, thread.scrollTop];
  const closed = measure();
  await userEvent.click(toggle);
  await phase(panel, "open");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("role")).toBe("dialog");
  expect(panel.dataset.placement).toBe("bottom");
  expect(panel.getBoundingClientRect().top).toBeGreaterThan(toggle.getBoundingClientRect().bottom);
  expect(panel.getBoundingClientRect().width).toBeLessThanOrEqual(460);
  expect(measure()).toEqual(closed);
  await userEvent.keyboard("{Escape}");
  await phase(panel, "hidden");
  expect(document.activeElement).toBe(toggle);
  await userEvent.click(toggle);
  await phase(panel, "open");
  await userEvent.click(document.body, { position: { x: 2, y: 690 } });
  await phase(panel, "hidden");
  expect(measure()).toEqual(closed);
});

it("flips above when the panel would cross the end of the transcript", async () => {
  const { toggle, panel, line } = mount(420, 360);
  await userEvent.click(toggle);
  await phase(panel, "open");
  expect(panel.dataset.placement).toBe("top");
  expect(line.dataset.placement).toBe("top");
  expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    toggle.getBoundingClientRect().top,
  );
});

it("closes when the transcript scrolls the line out of view", async () => {
  const { view, toggle, panel } = mount(300, 40);
  const thread = view.container.querySelector<HTMLElement>(".chat-thread")!;
  thread.append(Object.assign(document.createElement("div"), { style: "height: 900px" }));
  await userEvent.click(toggle);
  await phase(panel, "open");
  thread.scrollTop = 200;
  await phase(panel, "hidden");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

it("fades each scrollable edge of the log and clears the fade at that edge", async () => {
  const { view, toggle, panel } = mount(700, 40);
  const log = view.container.querySelector<HTMLElement>(".chat-run-failure__log")!;
  await userEvent.click(toggle);
  await phase(panel, "open");
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
  await phase(panel, "open");
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
