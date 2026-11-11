// @vitest-environment node
import { expect, it } from "vitest";
import { normalizeMessage } from "./message-normalizer.ts";

it.each(["paste", "file", undefined, "unknown"])(
  "retains only recorded attachment origins for history: %s",
  (origin) => {
    const attachment = {
      url: "/media/pasted-text-123.txt",
      kind: "document",
      label: "pasted-text-123.txt",
      mimeType: "text/plain",
    };
    const result = normalizeMessage({
      role: "user",
      content: [{ type: "attachment", attachment: { ...attachment, origin } }],
    });
    expect(result.content).toEqual([
      {
        type: "attachment",
        attachment: {
          ...attachment,
          ...(origin === "paste" || origin === "file" ? { origin } : {}),
        },
      },
    ]);
  },
);

it("keeps a delivered media name in text when a reference attachment has no URL", () => {
  const result = normalizeMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Voice note\nGenerated audio 1" },
      { type: "attachment", attachment: { kind: "audio", label: "Generated audio 1" } },
    ],
  });
  // The delivered-name text block survives; the URL-less reference attachment is dropped.
  expect(result.content).toEqual([{ type: "text", text: "Voice note\nGenerated audio 1" }]);
});
