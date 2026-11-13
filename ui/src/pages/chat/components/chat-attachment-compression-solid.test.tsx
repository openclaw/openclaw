// @vitest-environment jsdom
import { fireEvent } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AttachmentPreviewStrip } from "./chat-attachment-preview-strip.tsx";
import type { ChatAttachmentRead } from "./chat-attachment-reads.ts";

const attachment = {
  id: "synthetic-video",
  origin: "file" as const,
  fileName: "synthetic.mp4",
  mimeType: "video/mp4",
  sizeBytes: 200,
};

it.each([
  [
    "compressionUnsupported",
    "This browser cannot compress this video. Try a smaller file or another browser.",
  ],
  ["compressionTooLarge", "Video is still too large. Try a smaller file."],
  ["compressionFailed", "Could not compress video. Try again."],
])(
  "renders the %s cause and a reportable code beside retry, not in hidden text",
  (reason, message) => {
    const retry = vi.fn();
    const read: ChatAttachmentRead = {
      attachment,
      state: "error",
      errorMessage: "chat.attachments." + reason,
      compressionDiagnostic: "encoding/failed",
      compress: retry,
    };
    const view = mountSolid(() => (
      <AttachmentPreviewStrip
        entries={[{ ...read, read }]}
        controls={{ onAttachmentsChange: vi.fn() }}
      />
    ));
    const status = view.getByRole("status");
    expect(status.textContent).toContain(message);
    expect(status.textContent).toContain("Error code: encoding/failed");
    expect(status.classList.contains("sr-only")).toBe(false);
    expect(status.closest(".chat-attachment-thumb")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Retry compression" }));
    expect(retry).toHaveBeenCalledOnce();
  },
);

it.each([
  ["compressing", "Compressing · 85%"],
  ["preparing", "Preparing attachment · 3%"],
] as const)("labels %s progress with its actual phase", (preparation, label) => {
  const read: ChatAttachmentRead = {
    attachment,
    state: "reading",
    preparation,
    progress: preparation === "preparing" ? 0.03 : 0.85,
  };
  const view = mountSolid(() => (
    <AttachmentPreviewStrip
      entries={[{ ...read, read }]}
      controls={{ onAttachmentsChange: vi.fn() }}
    />
  ));
  expect(view.getByRole("status").textContent).toBe(label);
  expect(view.queryByRole("button", { name: "Compress to fit" })).toBeNull();
});
