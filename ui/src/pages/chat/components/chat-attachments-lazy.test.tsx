/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { AttachmentPreview, AttachmentReadStatus } from "./chat-attachments.tsx";

const imports = vi.hoisted(() => ({ previews: 0 }));

// mock-isolation: observe loading while retaining the real preview renderer.
vi.mock("./chat-attachment-preview-strip.tsx", async (importOriginal) => {
  imports.previews += 1;
  return importOriginal<typeof import("./chat-attachment-preview-strip.tsx")>();
});

it("loads preview rendering only for the first attachment without delaying read status", async () => {
  let setAttachments!: (attachments: ChatAttachment[]) => void;
  const view = mountSolid(() => {
    const [attachments, update] = createSignal<ChatAttachment[]>([]);
    setAttachments = update;
    return (
      <>
        <AttachmentPreview attachments={attachments()} />
        <AttachmentReadStatus pendingReads={2} />
      </>
    );
  });
  expect(imports.previews).toBe(0);
  expect(view.container.querySelector(".chat-attachments-status")?.textContent).toContain(
    "Preparing 2 attachments",
  );
  setAttachments([{ id: "first", mimeType: "text/plain", fileName: "report.txt" }]);
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-attachment-file__name")?.textContent).toBe(
      "report.txt",
    ),
  );
  expect(imports.previews).toBe(1);
  setAttachments([]);
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-attachments-preview")).toBeNull(),
  );
});
