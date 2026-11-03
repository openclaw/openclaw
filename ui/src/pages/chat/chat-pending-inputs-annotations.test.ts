import { describe, expect, it } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { buildPendingInputQueueItems } from "./chat-pending-inputs.ts";
import { describeChatQueueAttachmentLabels } from "./chat-queue-attachment-labels.ts";

function queuedComments(
  text: string,
  representation: "content" | "metadata" | "both",
): ChatPendingInputsPage["items"] {
  const media = ["first", "second"].map((id) => ({
    kind: "document",
    fileName: "selection-comment.txt",
    contentType: "text/plain",
    url: `media://inbound/${id}.txt`,
  }));
  return [
    {
      id: "annotation-input",
      acceptedAt: 100,
      state: "queued",
      queued: true,
      runId: "annotation-run",
      message: {
        role: "user",
        content:
          representation === "metadata"
            ? text
            : [
                { type: "text", text },
                ...media.map((entry) => ({
                  type: "attachment",
                  attachment: {
                    kind: entry.kind,
                    label: entry.fileName,
                    mimeType: entry.contentType,
                    url: entry.url,
                  },
                })),
              ],
        ...(representation !== "content" ? { __openclaw: { media } } : {}),
      },
    },
  ];
}

describe("annotation-only pending queue", () => {
  it.each(["content", "metadata", "both"] as const)(
    "uses %s comment attachments instead of blank text",
    (representation) => {
      for (const text of ["", "\n\n", " \t\r\n "]) {
        const rows = buildPendingInputQueueItems(queuedComments(text, representation));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          text: "2 annotations",
          pendingRunId: "annotation-run",
          serverQueued: true,
        });
      }
    },
  );

  it("keeps the prompt ahead of attachment labels", () => {
    const rows = buildPendingInputQueueItems(
      queuedComments("  Review these comments.\n", "metadata"),
    );
    expect(rows[0]?.text).toBe("Review these comments.");
  });
});

it.each([
  [["selection-comment.txt"], "1 annotation"],
  [["selection-comment.txt", "selection-comment.txt", "brief.pdf"], "2 annotations, brief.pdf"],
  [["brief.pdf"], "brief.pdf"],
] as const)("summarizes attachment labels %j", (labels, expected) => {
  expect(describeChatQueueAttachmentLabels(labels)).toBe(expected);
});
