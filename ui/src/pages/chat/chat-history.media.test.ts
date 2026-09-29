import { describe, expect, it } from "vitest";
import {
  isEmptyUserTextOnlyMessage,
  readTranscriptMediaEntries,
} from "../../lib/chat/message-extract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { projectMessageMedia } from "./components/chat-message-media.ts";

const MANAGED_UUID = "43007e90-2ade-43f2-a781-42b843e9eca3";

function userMessageWithMedia(media: unknown[]): {
  role: string;
  content: string;
  __openclaw: { media: unknown[] };
} {
  return { role: "user", content: "", __openclaw: { media } };
}

describe("chat history canonical media filtering", () => {
  it.each([
    ["sparse", [{}, { path: "/media/sparse.png", contentType: "image/png" }]],
    ["media-only", [{ url: "media://inbound/media-only.png", kind: "image" }]],
  ])("keeps an empty %s user row", (_name, media) => {
    expect(
      isEmptyUserTextOnlyMessage({
        role: "user",
        content: "",
        __openclaw: { media },
      }),
    ).toBe(false);
  });

  it("drops a truly empty user row", () => {
    expect(isEmptyUserTextOnlyMessage({ role: "user", content: "" })).toBe(true);
  });

  it("renders a safe media-only user turn without rendering metadata-only local media", () => {
    const safeRef = "media://inbound/safe-history-image.png";
    const items = buildChatItems({
      paneId: "media-history",
      sessionKey: "main",
      messages: [
        userMessageWithMedia([{ path: safeRef, contentType: "image/png" }]),
        userMessageWithMedia([{ contentType: "image/png", fileName: "metadata-only-local.png" }]),
      ],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    const serialized = JSON.stringify(items);

    expect(serialized).toContain(safeRef);
    expect(serialized).not.toContain("metadata-only-local.png");
  });
});

describe("chat history attachment card labels", () => {
  it.each(["paste", "file", undefined] as const)(
    "carries %s origin from persisted history to its displayed attachment",
    (origin) => {
      const { attachments } = projectMessageMedia(
        userMessageWithMedia([
          {
            path: `media://inbound/pasted-text-123---${MANAGED_UUID}.txt`,
            fileName: "pasted-text-123.txt",
            contentType: "text/plain",
            ...(origin ? { origin } : {}),
          },
        ]),
        [],
      );
      expect(attachments[0]?.attachment).toMatchObject({
        label: "pasted-text-123.txt",
        mimeType: "text/plain",
      });
      expect(attachments[0]?.type === "attachment" && attachments[0].attachment.origin).toBe(
        origin,
      );
    },
  );

  it("carries the persisted canonical fileName through the media projection", () => {
    const entries = readTranscriptMediaEntries(
      userMessageWithMedia([
        {
          path: `media://inbound/report---${MANAGED_UUID}.pdf`,
          fileName: "report.pdf",
          contentType: "application/pdf",
        },
      ]),
    );
    expect(entries[0]?.fileName).toBe("report.pdf");
  });

  it.each([
    {
      name: "labels a managed inbound attachment with the persisted original fileName",
      path: `media://inbound/report---${MANAGED_UUID}.pdf`,
      fileName: "report.pdf",
      contentType: "application/pdf",
      label: "report.pdf",
    },
    {
      name: "restores the original name from a legacy managed inbound UUID suffix when fileName is absent",
      path: `media://inbound/openclaw-attachment-test---${MANAGED_UUID}.docx`,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      label: "openclaw-attachment-test.docx",
    },
    {
      name: "leaves non-managed https attachment paths unchanged",
      path: "https://example.com/files/openclaw-attachment-test---old.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      label: "openclaw-attachment-test---old.docx",
    },
    {
      name: "does not strip a managed inbound basename that lacks a UUID suffix",
      path: "media://inbound/plain-name.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      label: "plain-name.docx",
    },
    {
      name: "strips only the terminal managed UUID suffix, preserving a UUID-shaped segment in the original name",
      path: `media://inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890-final---${MANAGED_UUID}.docx`,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      label: "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890-final.docx",
    },
  ])("$name", ({ name: _name, label, ...media }) => {
    const { attachments } = projectMessageMedia(userMessageWithMedia([media]), []);
    expect(attachments[0]?.attachment.label).toBe(label);
  });

  it("preserves a dotted UUID-shaped segment in a legacy attachment name", () => {
    const path = `media://inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.backup---${MANAGED_UUID}.pdf`;
    const { attachments } = projectMessageMedia(
      userMessageWithMedia([{ path, contentType: "application/pdf" }]),
      [],
    );

    expect(attachments[0]?.attachment).toMatchObject({
      url: path,
      label: "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.backup.pdf",
      mimeType: "application/pdf",
    });
    expect(attachments[0]?.attachment.label).not.toContain(MANAGED_UUID);
  });
});
