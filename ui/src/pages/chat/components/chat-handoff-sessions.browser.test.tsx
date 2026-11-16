import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { loadTypefaceStylesheet } from "../../../app/typography.ts";
import "../../../test-helpers/load-styles.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatHandoffSession } from "../chat-subagent-wait.ts";
import { ChatHandoffResume } from "./chat-handoff-sessions.tsx";

it("keeps handoff status pills compact when session titles wrap and the viewport narrows", async () => {
  const sessions: ChatHandoffSession[] = [
    { key: "short", label: "Verify controller input", status: "running" },
    {
      key: "long",
      label:
        "Phone as a real user: iOS Simulator Safari and touch, find and fix interaction problems across portrait and landscape, then verify the controller setup",
      status: "running",
    },
    {
      key: "plain",
      label: "Fix the blind play-testers' findings on the laptop engineer page",
      status: "running",
    },
    { key: "attention", label: "Review the headset interaction findings", status: "attention" },
    { key: "background", label: "Run the browser regression checks", status: "background" },
  ];
  const open = vi.fn();
  const view = mountSolid(() => (
    <ChatHandoffResume
      handoff={{ yieldedAt: 1_000, resumedAt: 450_000 }}
      sessions={sessions}
      links={(key) => (key === "plain" ? undefined : { href: "/chat/main/" + key, open })}
    />
  ));
  view.container.style.cssText = "max-width:720px;margin:24px;padding:16px";
  await page.viewport(820, 600);
  await userEvent.click(page.getByRole("button", { name: /Resumed/ }));
  await waitForSolid(() => expect(view.container.querySelectorAll("li")).toHaveLength(5));
  const fontStylesheet = loadTypefaceStylesheet("instrument-sans")!;
  await waitForSolid(() => expect(fontStylesheet.sheet).not.toBeNull());
  await document.fonts.load('12px "Instrument Sans"');
  await document.fonts.ready;

  for (const width of [820, 390, 820]) {
    await page.viewport(width, 600);
    const list = view.container.querySelector<HTMLElement>(".chat-handoff-sessions")!;
    const rows = [...list.querySelectorAll("li")];
    const short = rows[0]!.firstElementChild!.getBoundingClientRect();
    const long = rows[1]!.firstElementChild!.getBoundingClientRect();
    expect(long.height).toBeGreaterThan(short.height);
    for (const row of rows) {
      const name = row.firstElementChild!.getBoundingClientRect();
      const status = row.querySelector<HTMLElement>(".chat-handoff-sessions__status")!;
      const badge = status.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(status).lineHeight);
      expect(badge.height).toBeLessThanOrEqual(lineHeight + 2.5);
      expect(Math.abs(badge.top - name.top)).toBeLessThan(1);
      expect(name.right + 7.5).toBeLessThanOrEqual(badge.left);
      expect(badge.right).toBeLessThanOrEqual(list.getBoundingClientRect().right + 1);
    }
  }
  await userEvent.click(page.getByRole("link", { name: sessions[0]!.label }));
  expect(open).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole("button", { name: /Resumed/ }));
  await waitForSolid(() => expect(view.container.querySelector("ul")).toBeNull());
});
