/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatWorkContext } from "../pages/chat/chat-work-context.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./home-session-solid.tsx";

// mock-isolation: Home owns attachment controls; its child chat renderer is opaque.
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
  document.body.append(provider);
  const [work, setWork] = createSignal<ChatWorkContext>({ page: "chat", file: "first.ts" });
  const source = document.createElement("p");
  source.textContent = "Selected source text";
  document.body.append(source);
  const view = mountSolid(
    () => (
      <openclaw-home-session
        prop:sessionKey="agent:main:main"
        prop:agentId="main"
        prop:workContext={work()}
      />
    ),
    { baseElement: provider },
  );
  await waitForSolid(() =>
    expect(view.container.querySelector("openclaw-chat-pane")).not.toBeNull(),
  );
  const pane = view.container.querySelector("openclaw-chat-pane");
  const range = document.createRange();
  range.selectNodeContents(source);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  expect(selection.toString()).toBe("Selected source text");
  document.dispatchEvent(new Event("selectionchange"));
  const attach = view.getByRole("button", { name: "Attach selected text" });
  await waitForSolid(() => expect(attach.hasAttribute("disabled")).toBe(false));
  attach.click();
  await waitForSolid(() =>
    expect(view.container.querySelector("pre")?.textContent).toContain("Selected source text"),
  );

  setWork({ page: "chat", file: "first.ts", title: "Updated title" });
  await waitForSolid(() => {
    expect(view.container.querySelector("pre")?.textContent).toContain("Updated title");
    expect(view.container.querySelector("pre")?.textContent).toContain("Selected source text");
  });
  setWork({ page: "chat", file: "second.ts" });
  await waitForSolid(() =>
    expect(view.container.querySelector("pre")?.textContent).not.toContain("Selected source text"),
  );
  setWork({ page: "chat", file: "first.ts" });
  await waitForSolid(() => {
    expect(view.container.querySelector("pre")?.textContent).toContain("first.ts");
    expect(view.container.querySelector("pre")?.textContent).not.toContain("Selected source text");
  });
  expect(view.container.querySelector("openclaw-chat-pane")).toBe(pane);
});
