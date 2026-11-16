import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { ChatRunFailureNotice } from "./chat-run-failure-notice.tsx";
import "../../../styles/chat/run-failure.css";
import "../../../styles/base.css";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("dir");
});

it("expands the same full paragraph in place and keeps the heading available to collapse it", async () => {
  const trace = [
    "First `failure`",
    ...Array.from({ length: 8 }, (_, k) => `attempt ${k + 1}`),
  ].join("\n");
  const view = render(() => (
    <div
      class="chat-thread"
      style={{ position: "fixed", inset: "0 0 auto", height: "420px", overflow: "auto" }}
    >
      <div style={{ height: "360px" }} />
      <ChatRunFailureNotice summary={trace} onRetry={() => undefined} />
    </div>
  ));
  const part = (selector: string) => view.container.querySelector<HTMLElement>(selector)!;
  const summary = part(".chat-run-failure__summary");
  await expect.poll(() => part("button.chat-run-failure__toggle")).not.toBeNull();
  const toggle = part(".chat-run-failure__toggle");
  const closedHeight = summary.clientHeight;
  expect(summary.textContent).toBe(trace.replaceAll("`", ""));
  expect(summary.querySelector("code")?.textContent).toBe("failure");
  expect(summary.scrollHeight).toBeGreaterThan(closedHeight);
  await userEvent.click(toggle);
  await expect.poll(() => summary.clientHeight).toBeGreaterThan(closedHeight);
  expect(part(".chat-run-failure__summary")).toBe(summary);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-controls")).toBe(summary.id);
  expect(summary.scrollHeight).toBe(summary.clientHeight);
  expect(part(".chat-run-failure__chevron")).not.toBeNull();
  const thread = part(".chat-thread");
  await expect
    .poll(() => part(".chat-run-failure").getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(thread.getBoundingClientRect().bottom);
  expect(thread.scrollTop).toBeGreaterThan(0);
  await userEvent.click(toggle);
  await expect.poll(() => summary.clientHeight).toBe(closedHeight);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle);
});

it("only offers expansion when the paragraph is cut, including after width and text changes", async () => {
  const [width, setWidth] = createSignal("900px");
  const [text, setText] = createSignal(
    "A longer failure message that fits on a wide screen but needs more than three lines in a narrow card.",
  );
  document.documentElement.dir = "rtl";
  const view = render(() => (
    <div style={{ width: width() }}>
      <ChatRunFailureNotice summary={text()} />
    </div>
  ));
  const heading = () => view.container.querySelector<HTMLElement>(".chat-run-failure__toggle")!;
  const summary = view.container.querySelector<HTMLElement>(".chat-run-failure__summary")!;
  await expect.poll(() => summary.clientHeight).toBeGreaterThan(0);
  expect(heading().tagName).toBe("DIV");
  expect(heading().tabIndex).toBe(-1);
  expect(heading().hasAttribute("aria-expanded")).toBe(false);
  expect(view.container.querySelector(".chat-run-failure__chevron")).toBeNull();
  expect(summary.querySelector("bdi")?.textContent).toBe(text());
  setWidth("150px");
  await expect.poll(() => heading().tagName).toBe("BUTTON");
  setWidth("900px");
  await expect.poll(() => heading().tagName).toBe("DIV");
  setText("one\ntwo\nthree\nfour");
  await expect.poll(() => summary.textContent).toBe("one\ntwo\nthree\nfour");
  const fullHeight = summary.clientHeight;
  setText("one\ntwo\nthree\nfour\nfive");
  await expect.poll(() => heading().tagName).toBe("BUTTON");
  expect(summary.clientHeight).toBe(fullHeight);
  setText("Short error");
  await expect.poll(() => heading().tagName).toBe("DIV");
});
