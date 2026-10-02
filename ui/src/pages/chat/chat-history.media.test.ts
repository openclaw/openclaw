import { expect, it } from "vitest";
import { buildChatItems } from "./chat-thread-build.ts";
import { projectMessageMedia } from "./components/chat-message-media.ts";

const UUID = "43007e90-2ade-43f2-a781-42b843e9eca3";
const userMedia = (media: unknown[]) => ({ role: "user", content: "", __openclaw: { media } });

it("renders safe media-only history and filters empty or metadata-only user rows", () => {
  const safeRef = "media://inbound/safe-history-image.png";
  const items = buildChatItems({
    paneId: "media-history",
    sessionKey: "main",
    messages: [
      userMedia([{}, { url: safeRef, kind: "image" }]),
      userMedia([{ contentType: "image/png", fileName: "metadata-only-local.png" }]),
      { role: "user", content: "" },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  });
  expect(items).toHaveLength(1);
  expect(JSON.stringify(items)).toContain(safeRef);
  expect(JSON.stringify(items)).not.toContain("metadata-only-local.png");
});

it("carries paste origin and the persisted filename into the attachment card", () => {
  const { attachments } = projectMessageMedia(
    userMedia([
      {
        path: `media://inbound/pasted-text-123---${UUID}.txt`,
        fileName: "pasted-text-123.txt",
        contentType: "text/plain",
        origin: "paste",
      },
    ]),
    [],
  );
  expect(attachments[0]).toMatchObject({
    type: "attachment",
    attachment: { label: "pasted-text-123.txt", mimeType: "text/plain", origin: "paste" },
  });
});

it.each([
  {
    path: `media://inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.backup---${UUID}.pdf`,
    label: "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.backup.pdf",
  },
  { path: "https://example.com/files/report---old.pdf", label: "report---old.pdf" },
  { path: "media://inbound/plain-name.pdf", label: "plain-name.pdf" },
])("preserves the original filename for $path", ({ label, ...media }) => {
  const { attachments } = projectMessageMedia(
    userMedia([{ ...media, contentType: "application/pdf" }]),
    [],
  );
  expect(attachments[0]?.attachment).toMatchObject({
    url: media.path,
    label,
    mimeType: "application/pdf",
  });
});
