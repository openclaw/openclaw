/* @vitest-environment jsdom */

import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

it("retires a held send when the visible store changes and permits a new turn", async () => {
  const previous = createDeferred<SystemAgentChatResult>();
  const reply = (text: string): SystemAgentChatResult => ({
    sessionId: "custodian-session",
    reply: text,
    action: "none",
  });
  const request = vi
    .fn()
    .mockResolvedValueOnce(reply("First session ready"))
    .mockReturnValueOnce(previous.promise)
    .mockResolvedValueOnce(reply("Replacement session ready"))
    .mockResolvedValueOnce(reply("Replacement turn complete"));
  const { context } = createContext(request);
  const { page } = await mountPage(context);
  await waitForSolid(() => expect(page.textContent).toContain("First session ready"));
  const send = async (text: string) => {
    const input = page.querySelector("textarea")!;
    input.value = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const button = page.querySelector<HTMLButtonElement>(".chat-send-btn")!;
    await waitForSolid(() => expect(button.disabled).toBe(false));
    button.click();
  };
  await send("Old session turn");
  await waitForSolid(() => expect(page.querySelector(".custodian__thinking-row")).not.toBeNull());
  page.store = new CustodianSessionStore();
  await waitForSolid(() => expect(page.textContent).toContain("Replacement session ready"));
  expect(page.querySelector(".custodian__thinking-row")).toBeNull();
  await send("New session turn");
  await waitForSolid(() => expect(page.textContent).toContain("Replacement turn complete"));
  previous.resolve(reply("Retired turn complete"));
  await previous.promise;
  await waitForSolid(() => expect(page.textContent).not.toContain("Retired turn complete"));
});
