/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import type { OpenClawHomeSession } from "./home-session.runtime.ts";
import "./home-session.runtime.ts";

// mock-isolation: The Home attachment controls own this contract; the child chat renderer is opaque.
vi.mock("../pages/chat/chat-pane.ts", () => {
  customElements.define("openclaw-chat-pane", class extends HTMLElement {});
  return {};
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

it("captures external text, clears it on context changes, and retains the conversation", async () => {
  const context = createContext(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("main", []),
  );
  const provider = createApplicationContextProvider(context);
  render(
    html`<openclaw-home-session
      .sessionKey=${"agent:main:main"}
      .agentId=${"main"}
      .workContext=${{ page: "chat", file: "first.ts" }}
    ></openclaw-home-session>`,
    provider,
  );
  const source = document.createElement("p");
  source.textContent = "Selected source text";
  document.body.append(source, provider);
  const home = provider.querySelector<OpenClawHomeSession>("openclaw-home-session")!;
  await home.updateComplete;
  const pane = home.querySelector("openclaw-chat-pane");
  const range = document.createRange();
  range.selectNodeContents(source);
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  flush();
  const attach = home.querySelector<HTMLButtonElement>('[aria-label="Attach selected text"]');
  expect(attach?.disabled).toBe(false);
  attach!.click();
  flush();
  expect(home.querySelector("pre")?.textContent).toContain("Selected source text");

  home.workContext = { page: "chat", file: "first.ts", title: "Updated title" };
  await home.updateComplete;
  expect(home.querySelector("pre")?.textContent).toContain("Selected source text");

  home.workContext = { page: "chat", file: "second.ts" };
  await home.updateComplete;
  expect(home.querySelector("pre")?.textContent).not.toContain("Selected source text");
  home.workContext = { page: "chat", file: "first.ts" };
  await home.updateComplete;
  expect(home.querySelector("pre")?.textContent).not.toContain("Selected source text");
  expect(home.querySelector("openclaw-chat-pane")).toBe(pane);
});
