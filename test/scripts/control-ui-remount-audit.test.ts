// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createControlUiRemountAudit } from "../../scripts/lib/control-ui-remount-audit.ts";

let audit: ReturnType<typeof createControlUiRemountAudit> | undefined;
afterEach(() => {
  audit?.finish();
  audit = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("distinguishes physical moves from rebuilt descendants while retaining shell identity", () => {
  const rects = [new DOMRect(0, 0, 100, 100)];
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue(
    Object.assign(rects, { item: (index: number) => rects[index] ?? null }),
  );
  document.body.innerHTML = `<div class="shell"><aside class="sidebar"></aside>
    <openclaw-chat-page><div class="agent-chat__composer-shell"><input></div>
    <div class="chat-thread"><p>Synthetic reply</p></div></openclaw-chat-page></div>`;
  const shell = document.querySelector(".shell")!;
  const page = document.querySelector("openclaw-chat-page")!;
  const sidebar = document.querySelector(".sidebar")!;
  const replacement = page.cloneNode(true);
  audit = createControlUiRemountAudit();
  audit.start();
  shell.append(sidebar);
  page.replaceWith(replacement);
  // A later cleanup must not erase the snapshot captured at physical removal.
  page.replaceChildren();
  // Solid can insert a replacement before retiring the old subtree.
  const inserted = replacement.cloneNode(true);
  shell.insertBefore(inserted, replacement);
  shell.removeChild(replacement);
  const result = audit.finish();
  expect(result.attachments).toEqual({
    sidebar: { added: 1, removed: 1 },
    page: { added: 2, removed: 2 },
    composer: { added: 2, removed: 2 },
    transcript: { added: 2, removed: 2 },
  });
  expect(result.pairs).toEqual([
    { kind: "move", label: "aside.sidebar", elements: 1 },
    { kind: "rebuild", label: "openclaw-chat-page", elements: 5 },
    { kind: "rebuild", label: "openclaw-chat-page", elements: 5 },
  ]);
  expect(result.retainedVisible.map((entry) => entry.kind)).toEqual(["shell", "sidebar"]);
  expect(result.addedElements).toBe(11);
  expect(result.removedElements).toBe(11);
  expect(result.transient).toEqual([
    expect.objectContaining({ label: "openclaw-chat-page", elements: 5 }),
  ]);
});

it("preserves a transient page removed through its ancestor, including open shadow roots", () => {
  const host = document.createElement("div");
  document.body.append(host);
  audit = createControlUiRemountAudit();
  audit.start();
  const root = host.attachShadow({ mode: "open" });
  const page = document.createElement("openclaw-error-page");
  page.innerHTML = "<p>Synthetic error</p>";
  root.append(page);
  host.remove();
  page.textContent = "";
  const result = audit.finish();
  expect(result.attachments).toEqual({ page: { added: 1, removed: 1 } });
  expect(result.addedElements).toBe(2);
  expect(result.removedElements).toBe(3);
  expect(result.pairs).toEqual([]);
  expect(result.transient).toEqual([
    {
      label: "openclaw-error-page",
      elements: 2,
      scopes: [expect.objectContaining({ kind: "page", label: "openclaw-error-page" })],
    },
  ]);
});

it("bounds retained mutation evidence and restores native methods after finishing", () => {
  const native = Object.getOwnPropertyDescriptor(Element.prototype, "remove");
  const container = document.createElement("div");
  document.body.append(container);
  audit = createControlUiRemountAudit();
  audit.start();
  for (let index = 0; index < 260; index++) {
    const child = document.createElement("openclaw-agent-page");
    child.innerHTML = '<div class="chat-thread"><span></span></div>';
    container.append(child);
    child.remove();
    child.replaceChildren();
  }
  const result = audit.finish();
  expect(result.truncated).toBe(true);
  expect(result.addedSubtrees + result.removedSubtrees).toBe(520);
  expect(result.addedElements).toBe(780);
  expect(result.removedElements).toBe(780);
  expect(result.attachments).toEqual({
    page: { added: 260, removed: 260 },
    transcript: { added: 260, removed: 260 },
  });
  expect(result.transient).toHaveLength(256);
  expect(Object.getOwnPropertyDescriptor(Element.prototype, "remove")).toEqual(native);
});
