import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canReloadControlUiDocument } from "../../../app/document-reload-guard.ts";
import {
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "../../../app/stale-chunk-reload.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "./chat-detail-panel.ts";
import { setFileDraft } from "./chat-file-drafts.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const browserMode = "__vitest_browser__" in globalThis;
let page: (typeof import("vitest/browser"))["page"];
type FileContent = Extract<SidebarContent, { kind: "file" }>;
type DetailPanel = HTMLElement & { content: FileContent; updateComplete: Promise<unknown> };
const files: FileContent[] = [];

beforeAll(async () => {
  if (browserMode) {
    ({ page } = await import("vitest/browser"));
  }
});

afterEach(() => {
  document.body.replaceChildren();
  for (const file of files.splice(0)) {
    setFileDraft(file, null);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openFile(content: FileContent) {
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.content = content;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

describe.runIf(browserMode)("file draft document reload protection", () => {
  it("recovers closed file edits locally while the stale route is inert", async () => {
    document.body.append(document.createElement("openclaw-toast-host"));
    const file: FileContent = {
      kind: "file",
      name: "notes 雪.md",
      path: "reports/notes 雪.md",
      draftKey: crypto.randomUUID(),
      content: "Saved content",
      edit: { hash: "original-hash", save: vi.fn(), fetchLatest: vi.fn() },
    };
    files.push(file);
    const panel = await openFile(file);
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    const draft = "Unsaved café 雪 🦞\nKeep these bytes.\n";
    await page.getByRole("textbox", { name: file.name, exact: true }).fill(draft);
    panel.remove();
    const route = document.createElement("openclaw-router-outlet");
    route.inert = true;
    document.body.append(route);

    expect(canReloadControlUiDocument(true)).toBe(false);
    await expect
      .element(page.getByText("Save or discard your file edits before reloading.", { exact: true }))
      .toBeVisible();
    expect(
      document.querySelector(".app-toast__action"),
      "the blocked reload must offer local draft recovery",
    ).not.toBeNull();
    await page.getByRole("button", { name: "Review file drafts", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: file.path, exact: true }))
      .toHaveValue(draft);
    expect(document.querySelector("openclaw-modal-dialog")?.closest("[inert]")).toBeNull();
    await page.getByRole("button", { name: "Keep drafts", exact: true }).click();
    expect(canReloadControlUiDocument(true)).toBe(false);
    await page.getByRole("button", { name: "Review file drafts", exact: true }).click();

    const clipboard = vi.fn().mockRejectedValueOnce(new Error("Clipboard denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
    const fallback = vi.spyOn(document, "execCommand").mockReturnValue(false);
    await page.getByRole("button", { name: `Copy ${file.name}`, exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Could not copy the edits. Select the text or download the draft instead.",
      );
    expect(fallback).toHaveBeenCalledWith("copy");
    expect(canReloadControlUiDocument()).toBe(false);
    clipboard.mockResolvedValue(undefined);
    await page.getByRole("button", { name: `Copy ${file.name}`, exact: true }).click();
    expect(clipboard).toHaveBeenCalledWith(draft);
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered-file");
    const downloadedNames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedNames.push(this.download);
    });
    await page.getByRole("button", { name: `Download ${file.name}`, exact: true }).click();
    const blob = createUrl.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) {
      throw new Error("Expected the recovered file bytes");
    }
    expect(await blob.text()).toBe(draft);
    expect(downloadedNames).toEqual([file.name]);
    expect(canReloadControlUiDocument()).toBe(false);
    await page.getByRole("button", { name: `Discard ${file.name}`, exact: true }).click();
    expect(canReloadControlUiDocument()).toBe(true);
    expect(route.inert).toBe(true);
    expect(file.edit?.save).not.toHaveBeenCalled();
    expect(file.edit?.fetchLatest).not.toHaveBeenCalled();
  });

  it("does not discard newer or newly retained drafts from an older recovery dialog", async () => {
    document.body.append(document.createElement("openclaw-toast-host"));
    const createFile = (name: string): FileContent => {
      const file: FileContent = {
        kind: "file",
        name,
        path: name,
        draftKey: crypto.randomUUID(),
        content: "Saved",
        edit: {
          hash: "disk-hash",
          save: vi.fn().mockResolvedValue({ ok: true, hash: "saved-hash" }),
          fetchLatest: vi.fn(),
        },
      };
      files.push(file);
      return file;
    };
    const first = createFile("first.txt");
    const second = createFile("second.txt");
    const later = createFile("later.txt");
    setFileDraft(first, { content: "Original draft", expectedHash: "first-hash" });
    setFileDraft(second, { content: "Second draft", expectedHash: "second-hash" });
    expect(canReloadControlUiDocument(true)).toBe(false);
    await page.getByRole("button", { name: "Review file drafts", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: first.path, exact: true }))
      .toHaveValue("Original draft");
    setFileDraft(first, { content: "Newer draft", expectedHash: "newer-hash" });
    setFileDraft(later, { content: "Later draft", expectedHash: "later-hash" });
    await page.getByRole("button", { name: "Discard first.txt", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("These edits changed. Close this dialog and review the drafts again.");
    await page.getByRole("button", { name: "Discard second.txt", exact: true }).click();
    expect(canReloadControlUiDocument()).toBe(false);
    await page.getByRole("button", { name: "Keep drafts", exact: true }).click();
    for (const [file, text, hash] of [
      [first, "Newer draft", "newer-hash"],
      [later, "Later draft", "later-hash"],
    ] as const) {
      const panel = await openFile(file);
      await expect
        .element(page.getByRole("textbox", { name: file.name, exact: true }))
        .toHaveTextContent(text);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      expect(file.edit?.save).toHaveBeenCalledWith({ content: text, expectedHash: hash });
      panel.remove();
      expect(canReloadControlUiDocument()).toBe(file === later);
    }
  });

  it.each([
    { mode: "automatic", settle: "Save" },
    { mode: "automatic", settle: "Discard" },
    { mode: "manual", settle: "Save" },
    { mode: "manual", settle: "Discard" },
  ] as const)(
    "blocks $mode reload until the last closed draft is resolved with $settle",
    async ({ mode, settle }) => {
      document.body.append(document.createElement("openclaw-toast-host"));
      const fetchDocument = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchDocument);
      const reload = vi.fn();
      const attempt = () => {
        const entries = new Map<string, string>();
        const storage = {
          getItem: (key: string) => entries.get(key) ?? null,
          setItem: (key: string, value: string) => void entries.set(key, value),
        };
        return mode === "automatic"
          ? scheduleStaleChunkReload({ storage, reload })
          : retryStaleChunkReloadWhenReachable({ storage, reload, timeoutMs: 0 });
      };
      const createFile = (name: string): FileContent => {
        const file: FileContent = {
          kind: "file",
          name,
          path: name,
          draftKey: crypto.randomUUID(),
          content: "Saved content",
          edit: {
            hash: "original-hash",
            save: vi.fn().mockResolvedValue({ ok: true, hash: "saved-hash" }),
            fetchLatest: vi.fn(),
          },
        };
        files.push(file);
        return file;
      };
      const first = createFile("first.txt");
      const second = createFile("second.txt");
      let panel = await openFile(first);
      await expect(attempt()).resolves.toBe(true);
      expect(reload).toHaveBeenCalledOnce();
      reload.mockClear();
      fetchDocument.mockClear();

      for (const file of [first, second]) {
        if (file === second) {
          panel = await openFile(file);
        }
        await page.getByRole("button", { name: "Edit file", exact: true }).click();
        await page
          .getByRole("textbox", { name: file.name, exact: true })
          .fill(`Draft for ${file.name}`);
        panel.remove();
      }
      await expect(attempt()).resolves.toBe(false);
      expect(fetchDocument).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      if (mode === "manual") {
        await expect
          .element(
            page.getByText("Save or discard your file edits before reloading.", { exact: true }),
          )
          .toBeVisible();
      }

      for (const file of [first, second]) {
        panel = await openFile(file);
        await expect
          .element(page.getByRole("textbox", { name: file.name, exact: true }))
          .toHaveTextContent(`Draft for ${file.name}`);
        await page.getByRole("button", { name: settle, exact: true }).click();
        if (settle === "Save") {
          await expect
            .element(page.getByRole("button", { name: "Save", exact: true }))
            .toBeDisabled();
          expect(file.edit?.save).toHaveBeenCalledWith({
            content: `Draft for ${file.name}`,
            expectedHash: "original-hash",
          });
        }
        panel.remove();
        await expect(attempt()).resolves.toBe(file === second);
      }
      expect(reload).toHaveBeenCalledOnce();
      expect(fetchDocument).toHaveBeenCalledOnce();
    },
  );
});
