import { createSignal } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "../chat-application-context.test-support.ts";
import { createTestChatPane } from "../chat-pane.test-support.ts";
import { createChatProps } from "../chat-view.test-helpers.ts";
import { ChatDetailSlot } from "./chat-detail-slot-view.tsx";
import { setFileDraft } from "./chat-file-drafts.ts";
import type {
  FileSidebarContent,
  FileSidebarNavigation,
  SidebarSelection,
} from "./chat-sidebar-content-types.ts";

const browserMode = "__vitest_browser__" in globalThis;
const files: FileSidebarContent[] = [];
let userEvent: (typeof import("vitest/browser"))["userEvent"];
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});

function file(name = "report.md", editable = true): FileSidebarContent {
  const content: FileSidebarContent = {
    kind: "file",
    name,
    path: name,
    draftKey: crypto.randomUUID(),
    content: `# Report\nReady for review: ${name}.\n`,
    ...(editable ? { edit: { hash: "original", save: vi.fn(), fetchLatest: vi.fn() } } : {}),
  };
  files.push(content);
  return content;
}

afterEach(() => {
  for (const content of files.splice(0)) {
    setFileDraft(content, null);
  }
});

function mountRequest(content: FileSidebarContent, requestedFile = content) {
  const [selected, publish] = createSignal<SidebarSelection>(
    { kind: "loading" },
    { equals: false },
  );
  let current = content;
  let navigation: FileSidebarNavigation = {
    view: { file: requestedFile, view: "edit" },
  };
  const pane = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const chat = createChatProps();
  const context = createInitializationContext();
  const onFileInteraction = vi.fn();
  // The slot publishes the loaded file and its identity-bound view request together.
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <ChatDetailSlot
        host={pane.state}
        chat={chat}
        content={selected()}
        presentation="desktop"
        onFileInteraction={onFileInteraction}
      />
    </ApplicationProvider>
  ));
  function select(next: FileSidebarContent) {
    current = next;
    current.navigation = navigation;
    publish(current);
  }
  function navigate(next: FileSidebarNavigation) {
    navigation = next;
    select(current);
  }
  select(content);
  return { ...view, select, navigate, onFileInteraction };
}

describe.runIf(browserMode)("file view request delivery", () => {
  it("opens a cold file for editing once and preserves its draft on later view requests", async () => {
    const content = file();
    const view = mountRequest(content);
    const editable = () =>
      view.container.querySelector<HTMLElement>('.cm-content[contenteditable="true"]');
    await expect.poll(editable, { timeout: 5_000 }).not.toBeNull();
    const editor = editable()!;
    const edits = () =>
      view.onFileInteraction.mock.calls.filter(([, interaction]) => interaction === "edit");
    expect(edits()).toEqual([[content, "edit"]]);
    await userEvent.fill(editor, "Unsaved report draft");
    for (const mode of ["reading", "edit"] as const) {
      view.navigate({ view: { file: content, view: mode } });
      // Request delivery uses commit microtasks; observe after their native frame boundary.
      await new Promise(requestAnimationFrame);
      expect(edits()).toHaveLength(mode === "edit" ? 2 : 1);
      expect(editable()).toBe(editor);
      expect(editor.textContent).toBe("Unsaved report draft");
      expect(view.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
    }
    expect(content.edit?.save).not.toHaveBeenCalled();
  });

  it("consumes a mismatched request without applying it to a later matching selection", async () => {
    const first = file();
    const second = file("other.md");
    const view = mountRequest(first, second);
    await expect.poll(() => view.container.querySelector(".sidebar-markdown")).not.toBeNull();
    view.select(second);
    await expect
      .poll(() => view.container.querySelector(".sidebar-markdown")?.textContent)
      .toContain("other.md");
    await new Promise(requestAnimationFrame);
    expect(view.onFileInteraction).not.toHaveBeenCalledWith(second, "edit");
    expect(view.container.querySelector('.cm-content[contenteditable="true"]')).toBeNull();
    view.navigate({ view: { file: second, view: "edit" } });
    await expect
      .poll(() => view.container.querySelector('.cm-content[contenteditable="true"]'))
      .not.toBeNull();
  });

  it("keeps a file without edit capability readonly", async () => {
    const view = mountRequest(file("report.md", false));
    await expect.poll(() => view.container.querySelector(".sidebar-markdown")).not.toBeNull();
    await new Promise(requestAnimationFrame);
    expect(view.onFileInteraction).not.toHaveBeenCalled();
    expect(view.container.querySelector('.cm-content[contenteditable="true"]')).toBeNull();
    expect(view.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
