import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AnswerLens } from "../answer-lens.ts";
import { AnswerLensControl } from "./chat-answer-lens-action.tsx";
import "../../../styles/base.css";
import "../../../styles/components.css";

afterEach(cleanupSolid);

it.each([400, 1280])("offers independent level menus above the controls at %ipx", async (width) => {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 800);
  onTestFinished(() => page.viewport(previous.width, previous.height));
  const request = createGatewayRequestMock();
  const owner = new AnswerLens();
  owner.configure({
    client: createTestGatewayClient(request),
    epoch: 1,
    sessionKey: "agent:test:lens",
  });
  const source = {
    messageId: "test",
    text: "An explanation with important qualifications. ".repeat(8),
  };
  request.mockImplementation(async (_method, params) => ({
    ...asOptionalRecord(params),
    text: "An adjusted explanation.",
    sourceRevision: "rev",
    durationMs: 1,
  }));
  const view = mountSolid(() => (
    <div style={{ margin: "300px 40px" }}>
      <AnswerLensControl owner={owner} source={source} />
    </div>
  ));
  const length = view.getByRole("button", { name: "Length" });
  const wording = view.getByRole("button", { name: "Wording" });
  await userEvent.click(length);
  const popup = view.getByRole("dialog", { name: "Length" });
  await expect.poll(() => popup.dataset.phase).toBe("open");
  const bounds = popup.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(bounds.bottom).toBeLessThanOrEqual(length.getBoundingClientRect().top);
  expect(popup.querySelectorAll(".answer-lens__point")).toHaveLength(3);
  const levels = [...popup.querySelectorAll(".answer-lens__point")].map((dot) =>
    dot.getBoundingClientRect(),
  );
  expect(levels[0]!.x).toBe(levels[1]!.x);
  expect(levels[1]!.x).toBe(levels[2]!.x);
  expect(levels[0]!.bottom).toBeLessThan(levels[1]!.top);
  expect(levels[1]!.bottom).toBeLessThan(levels[2]!.top);
  expect(popup.textContent).toBe("FullShorterGist");
  expect(request).not.toHaveBeenCalled();
  await userEvent.click(view.getByRole("button", { name: "Shorter" }));
  await expect.poll(() => owner.read(source)?.pending).toBeUndefined();
  expect(owner.read(source)?.target).toEqual({ coverage: "condensed", wording: "technical" });
  await expect.poll(() => length.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(wording);
  await userEvent.click(view.getByRole("button", { name: "Simple" }));
  await expect.poll(() => owner.read(source)?.pending).toBeUndefined();
  expect(owner.read(source)?.target).toEqual({ coverage: "condensed", wording: "plain" });
  await userEvent.click(length);
  expect(view.getByRole("button", { name: "Shorter" }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.keyboard("[Escape]");
  expect(document.activeElement).toBe(length);
  for (let index = 0; index < 4; index++) {
    await userEvent.click(wording);
    await userEvent.keyboard("[Escape]");
    expect(wording.getAttribute("aria-expanded")).toBe("false");
  }
  await userEvent.click(wording);
  view.getByRole("button", { name: "Technical" }).focus();
  await userEvent.keyboard("[Enter]");
  await userEvent.click(length);
  await userEvent.click(view.getByRole("button", { name: "Full" }));
  await expect
    .poll(() => owner.read(source)?.target)
    .toEqual({ coverage: "full", wording: "technical" });
  expect(owner.read(source)?.displayed?.wording).toBe("technical");
});
