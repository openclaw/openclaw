// @vitest-environment jsdom
import { fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { CompactAttachmentCard, AttachmentCardHeader } from "./chat-attachment-card-solid.tsx";

it("keeps downloads separate from opening the attachment, including detached SVG targets", () => {
  const open = vi.fn();
  const download = vi.fn();
  const view = mountSolid(() => (
    <CompactAttachmentCard
      kind="document"
      label="notes.pdf"
      onExpand={open}
      onDownload={download}
    />
  ));
  flush();
  const downloadButton = view.getByRole("button", { name: /download/i });
  const icon = downloadButton.querySelector("svg")!;
  downloadButton.addEventListener("click", () => icon.remove());
  fireEvent.click(icon);
  expect(download).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(view.getByText("notes.pdf"));
  expect(open).toHaveBeenCalledOnce();
  fireEvent.click(view.getByRole("button", { name: /open/i }));
  expect(open).toHaveBeenCalledTimes(2);
});

it("updates pending download links and file metadata without replacing the card", () => {
  const [pending, setPending] = createSignal(true);
  const [label, setLabel] = createSignal("report.pdf");
  const view = mountSolid(() => (
    <AttachmentCardHeader
      kind="document"
      label={label()}
      mimeType="application/pdf"
      sizeBytes={1024}
      downloadHref="/report.pdf"
      downloadPending={pending()}
      downloadPendingFocusable
    />
  ));
  flush();
  const link = view.getByRole("link", { name: /download/i });
  expect(link.hasAttribute("href")).toBe(false);
  expect(link.getAttribute("aria-disabled")).toBe("true");
  expect(link.tabIndex).toBe(0);
  expect(view.getByText(/PDF ·/)).toBeTruthy();
  setPending(false);
  setLabel("revised.pdf");
  flush();
  expect(view.getByRole("link", { name: /download/i })).toBe(link);
  expect(link.getAttribute("href")).toBe("/report.pdf");
  expect(link.hasAttribute("aria-disabled")).toBe(false);
  expect(link.getAttribute("download")).toBe("revised.pdf");
  expect(view.queryByText("report.pdf")).toBeNull();
  expect(view.getByText("revised.pdf")).toBeTruthy();
});
