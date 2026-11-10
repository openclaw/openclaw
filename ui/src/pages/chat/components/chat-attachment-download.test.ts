/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { downloadBlobFile } from "../../../lib/download.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { AttachmentSidebarContent } from "./chat-sidebar-content-types.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "./chat-detail-panel.tsx";

// mock-isolation: Observe browser delivery while the real panel owns each download.
vi.mock("../../../lib/download.ts", () => ({ downloadBlobFile: vi.fn() }));
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function mountDownload() {
  const first = Promise.withResolvers<Blob | null>();
  const replacement = Promise.withResolvers<Blob | null>();
  const download = vi
    .fn<NonNullable<AttachmentSidebarContent["download"]>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(replacement.promise);
  const container = createChatSidebarContainer();
  const panel = document.createElement("openclaw-chat-detail-panel");
  panel.attachmentRuntime = { connectionEpoch: 1 };
  panel.content = {
    kind: "attachment",
    attachmentKind: "document",
    title: "bundle.zip",
    mimeType: "application/zip",
    download,
  };
  container.append(panel);
  document.body.append(container);
  await panel.updateComplete;
  const button = () =>
    panel.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__download")!;
  await waitForSolid(() => expect(button()).not.toBeNull());
  const pending = (value: boolean) => waitForSolid(() => expect(button().disabled).toBe(value));
  const start = async () => {
    button().click();
    await pending(true);
  };
  await start();
  return { panel, button, first, replacement, download, pending, start };
}

it("shows pending and failure, then delivers the retried attachment", async () => {
  const { panel, button, first, replacement, pending, start } = await mountDownload();
  const initialButton = button();
  first.reject(new Error("Download unavailable"));
  await pending(false);
  expect(button()).toBe(initialButton);
  expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Download unavailable");
  await start();
  expect(button()).toBe(initialButton);
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  const blob = new Blob(["archive"]);
  replacement.resolve(blob);
  await pending(false);
  expect(downloadBlobFile).toHaveBeenCalledExactlyOnceWith("bundle.zip", blob);
});

it.each([
  ["content", "resolve"],
  ["content", "reject"],
  ["connection", "resolve"],
  ["disconnect", "resolve"],
] as const)("retires %s downloads before late %s", async (change, settlement) => {
  const { panel, first, replacement, download, pending, start } = await mountDownload();
  if (change === "content") {
    panel.content = { ...(panel.content as AttachmentSidebarContent), title: "replacement.zip" };
  } else if (change === "connection") {
    panel.attachmentRuntime = { connectionEpoch: 2 };
  } else {
    panel.remove();
    // Same-turn reparenting retains the bridge; actual disconnection must retire it.
    await Promise.resolve();
  }
  expect(download.mock.calls[0]![0].aborted).toBe(true);
  const blob = new Blob(["replacement"]);
  if (change !== "disconnect") {
    await pending(false);
    await start();
    if (change === "connection") {
      replacement.resolve(blob);
      await pending(false);
      expect(downloadBlobFile).toHaveBeenCalledExactlyOnceWith("bundle.zip", blob);
    }
  }
  if (settlement === "resolve") {
    first.resolve(new Blob(["stale"]));
  } else {
    first.reject(new Error("Retired download failed"));
  }
  await first.promise.catch(() => {});
  await Promise.resolve();
  expect(downloadBlobFile).toHaveBeenCalledTimes(change === "connection" ? 1 : 0);
  if (change === "content") {
    await pending(true);
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    replacement.resolve(blob);
    await pending(false);
    expect(downloadBlobFile).toHaveBeenCalledExactlyOnceWith("replacement.zip", blob);
  }
});
