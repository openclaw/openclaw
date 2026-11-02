import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AnswerLens } from "../answer-lens.ts";
import { AnswerLensControl } from "./chat-answer-lens-action.tsx";
import "../../../styles/base.css";
import "../../../styles/chat/answer-lens.css";

afterEach(cleanupSolid);

it.each([400, 1280])("offers independent dot menus above the controls at %ipx", async (width) => {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 800);
  onTestFinished(() => page.viewport(previous.width, previous.height));
  const request = vi.fn<GatewayBrowserClient["request"]>();
  const owner = new AnswerLens();
  owner.configure({ client: { request }, epoch: 1, sessionKey: "agent:test:lens" });
  const source = {
    messageId: "test",
    text: "An explanation with important qualifications. ".repeat(8),
  };
  request.mockImplementation(async (_method, params) => ({
    ...params,
    text: "An adjusted explanation.",
    sourceRevision: "rev",
    durationMs: 1,
  }));
  const view = mountSolid(() => (
    <div style={{ margin: "300px 40px" }}>
      <AnswerLensControl owner={owner} source={source} />
    </div>
  ));
  const length = view.getByRole("button", { name: "Length", exact: true });
  const wording = view.getByRole("button", { name: "Wording", exact: true });
  await userEvent.click(length);
  const popup = view.getByRole("dialog", { name: "Length", exact: true });
  await expect.poll(() => popup.dataset.phase).toBe("open");
  const bounds = popup.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(bounds.bottom).toBeLessThanOrEqual(length.getBoundingClientRect().top);
  expect(popup.querySelectorAll(".answer-lens__dot")).toHaveLength(3);
  const dots = [...popup.querySelectorAll(".answer-lens__dot")].map((dot) =>
    dot.getBoundingClientRect(),
  );
  expect(dots[0].x).toBe(dots[1].x);
  expect(dots[1].x).toBe(dots[2].x);
  expect(dots[0].bottom).toBeLessThan(dots[1].top);
  expect(dots[1].bottom).toBeLessThan(dots[2].top);
  expect(popup.textContent).toBe("FullGist");
  expect(request).not.toHaveBeenCalled();
  await userEvent.click(view.getByRole("button", { name: "Shorter", exact: true }));
  await expect.poll(() => owner.read(source)?.pending).toBeUndefined();
  expect(owner.read(source)?.target).toEqual({ coverage: "condensed", wording: "technical" });
  await expect.poll(() => length.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(wording);
  await userEvent.click(view.getByRole("button", { name: "Simple", exact: true }));
  await expect.poll(() => owner.read(source)?.pending).toBeUndefined();
  expect(owner.read(source)?.target).toEqual({ coverage: "condensed", wording: "plain" });
  await userEvent.click(length);
  expect(
    view.getByRole("button", { name: "Shorter", exact: true }).getAttribute("aria-pressed"),
  ).toBe("true");
  await userEvent.keyboard("[Escape]");
  expect(document.activeElement).toBe(length);
  for (let index = 0; index < 4; index++) {
    await userEvent.click(wording);
    await userEvent.keyboard("[Escape]");
    expect(wording.getAttribute("aria-expanded")).toBe("false");
  }
  await userEvent.click(wording);
  view.getByRole("button", { name: "Technical", exact: true }).focus();
  await userEvent.keyboard("[Enter]");
  await userEvent.click(length);
  await userEvent.click(view.getByRole("button", { name: "Full", exact: true }));
  await expect
    .poll(() => owner.read(source)?.target)
    .toEqual({ coverage: "full", wording: "technical" });
  expect(owner.read(source)?.displayed?.wording).toBe("technical");
});
