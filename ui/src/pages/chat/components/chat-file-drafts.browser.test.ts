import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
