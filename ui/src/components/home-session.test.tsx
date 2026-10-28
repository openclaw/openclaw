/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import type { ChatWorkContext } from "../pages/chat/chat-work-context.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { HomeSession } from "./home-session-solid.tsx";

// mock-isolation: Home owns attachment controls; its child chat renderer is opaque.
vi.mock("../pages/chat/chat-pane.tsx", () => {
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
      <ApplicationProvider value={context}>
        <HomeSession sessionKey="agent:main:main" agentId="main" workContext={work()} />
      </ApplicationProvider>
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

it.each([false, true])(
  "confirms restricted dock Home before loading chat (visible: %s)",
  async (visible) => {
    const request = vi.fn(async () => {
      if (!visible) {
        throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "No session found" });
      }
      return { ok: true, key: "agent:main:main", agentId: "main" };
    });
    const context = createContext(
      createGateway(createTestGatewayClient(request)),
      createSessions("main", []),
    );
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    };
    const hello = gatewayHelloForMethods(["sessions.resolve"], ["operator.sessions.write"]);
    hello.auth!.sessionCap = "none";
    context.gateway.snapshot.hello = hello;
    const navigate = vi.spyOn(context, "navigate");
    const view = mountSolid(() => (
      <ApplicationProvider value={context}>
        <HomeSession sessionKey="agent:main:main" agentId="main" />
      </ApplicationProvider>
    ));
    if (visible) {
      await waitForSolid(() =>
        expect(view.container.querySelector("openclaw-chat-pane")).not.toBeNull(),
      );
    } else {
      await waitForSolid(() =>
        expect(view.container.textContent).toContain("This Home is unavailable."),
      );
      expect(view.container.querySelector("openclaw-chat-pane")).toBeNull();
      view.getByRole("button", { name: "New conversation" }).click();
      expect(navigate).toHaveBeenCalledWith("new-session", { search: "?agent=main" });
    }
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.resolve", {
      key: "agent:main:main",
      agentId: "main",
      allowMissing: true,
    });
  },
);
