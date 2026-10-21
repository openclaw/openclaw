/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { downloadBlobFile } from "../../../lib/download.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { AttachmentSidebarContent } from "./chat-sidebar-content-types.ts";
import type { ChatDetailPanel } from "./chat-sidebar-view-types.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "./chat-detail-panel.tsx";

// mock-isolation: The panel's download owner runs; browser file delivery is observed at its boundary.
vi.mock("../../../lib/download.ts", () => ({ downloadBlobFile: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function mountDownload(download: AttachmentSidebarContent["download"]) {
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
  await waitForSolid(() => expect(downloadButton(panel)).not.toBeNull());
  return panel;
}

function downloadButton(panel: ChatDetailPanel) {
  return panel.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__download")!;
}

it("shows pending and failure, then delivers the retried attachment", async () => {
  const first = Promise.withResolvers<Blob | null>();
  const second = Promise.withResolvers<Blob | null>();
  const download = vi
    .fn<NonNullable<AttachmentSidebarContent["download"]>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const panel = await mountDownload(download);
  downloadButton(panel).click();
  expect(download).toHaveBeenCalledOnce();
  await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(true));
  first.reject(new Error("Download unavailable"));
  await waitForSolid(() => {
    expect(downloadButton(panel).disabled).toBe(false);
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Download unavailable");
  });
  downloadButton(panel).click();
  await waitForSolid(() => {
    expect(downloadButton(panel).disabled).toBe(true);
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });
  const blob = new Blob(["archive"]);
  second.resolve(blob);
  await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(false));
  expect(downloadBlobFile).toHaveBeenCalledExactlyOnceWith("bundle.zip", blob);
});

it.each(["content", "connection", "disconnect"] as const)(
  "retires a held download on %s without awaiting a transport that ignores abort",
  async (change) => {
    const held = Promise.withResolvers<Blob | null>();
    const download = vi
      .fn<NonNullable<AttachmentSidebarContent["download"]>>()
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(new Blob(["new archive"]));
    const panel = await mountDownload(download);
    downloadButton(panel).click();
    await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(true));
    const signal = download.mock.calls[0]![0];
    if (change === "content") {
      panel.content = { ...(panel.content as AttachmentSidebarContent), title: "next.zip" };
    } else if (change === "connection") {
      panel.attachmentRuntime = { connectionEpoch: 2 };
    } else {
      panel.remove();
      // The bridge keeps the same renderer through a same-turn reparent.
      await Promise.resolve();
    }
    expect(signal.aborted).toBe(true);
    if (change !== "disconnect") {
      await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(false));
      downloadButton(panel).click();
      await waitForSolid(() => expect(downloadBlobFile).toHaveBeenCalledOnce());
    }
    held.resolve(new Blob(["stale archive"]));
    await held.promise;
    await Promise.resolve();
    expect(downloadBlobFile).toHaveBeenCalledTimes(change === "disconnect" ? 0 : 1);
  },
);

it("keeps the replacement download pending when a retired request settles", async () => {
  const retired = Promise.withResolvers<Blob | null>();
  const replacement = Promise.withResolvers<Blob | null>();
  const download = vi
    .fn<NonNullable<AttachmentSidebarContent["download"]>>()
    .mockReturnValueOnce(retired.promise)
    .mockReturnValueOnce(replacement.promise);
  const panel = await mountDownload(download);
  downloadButton(panel).click();
  await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(true));

  panel.content = { ...(panel.content as AttachmentSidebarContent), title: "replacement.zip" };
  await panel.updateComplete;
  await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(false));
  downloadButton(panel).click();
  await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(true));
  expect(download).toHaveBeenCalledTimes(2);

  retired.resolve(new Blob(["retired archive"]));
  await retired.promise;
  await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(true));
  expect(downloadBlobFile).not.toHaveBeenCalled();

  const blob = new Blob(["replacement archive"]);
  replacement.resolve(blob);
  await waitForSolid(() => expect(downloadButton(panel).disabled).toBe(false));
  expect(downloadBlobFile).toHaveBeenCalledExactlyOnceWith("replacement.zip", blob);
});
