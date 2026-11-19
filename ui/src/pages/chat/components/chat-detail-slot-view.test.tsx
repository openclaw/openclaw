/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "../chat-application-context.test-support.ts";
import { createTestChatPane } from "../chat-pane.test-support.ts";
import { createChatProps } from "../chat-view.test-helpers.ts";
import { ChatDetailSlot } from "./chat-detail-slot-view.tsx";
import type { SidebarSelection } from "./chat-sidebar-content-types.ts";

const imports = vi.hoisted(() => ({ output: 0 }));

// mock-isolation: count evaluation without replacing the native output renderer.
vi.mock("./chat-tool-output-view.tsx", async (importOriginal) => {
  imports.output += 1;
  return importOriginal<typeof import("./chat-tool-output-view.tsx")>();
});

it("keeps tool output cold until selected and retains its native view across updates", async () => {
  expect(imports.output).toBe(0);
  const pane = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const chat = createChatProps();
  const output: SidebarSelection = {
    kind: "tool-output",
    card: {
      id: "tool",
      name: "exec",
      completed: true,
      inputText: "echo hello",
      outputText: "hello",
    },
  };
  const [content, setContent] = createSignal<SidebarSelection>({ kind: "loading" });
  const view = mountSolid(() => (
    <ChatDetailSlot chat={chat} host={pane.state} content={content()} />
  ));
  expect(imports.output).toBe(0);
  setContent(output);
  flush();
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-tool-output__text")?.textContent).toBe("hello"),
  );
  expect(imports.output).toBe(1);
  const host = view.container.querySelector("openclaw-chat-tool-output");
  const details = view.container.querySelector("details")!;
  details.open = true;
  setContent({ ...output, card: { ...output.card, outputText: "updated" } });
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-tool-output__text")?.textContent).toBe("updated"),
  );
  expect(view.container.querySelector("openclaw-chat-tool-output")).toBe(host);
  expect(view.container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
});
