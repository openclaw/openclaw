import { expect, it } from "vitest";
import { buildChatApiAttachments } from "./attachment-api.ts";
import { restoreChatApiAttachments } from "./attachment-restoration.ts";

it.each([
  { mediaType: "text/plain;charset=utf-8", mimeType: "text/plain", type: "file" },
  {
    mediaType: "text/plain;charset=utf-8;name=notes%20copy.txt",
    mimeType: "text/plain",
    type: "file",
  },
  { mediaType: "image/png;name=preview.png", mimeType: "image/png", type: "image" },
])(
  "converts parameterized $mediaType data URLs into chat attachments",
  ({ mediaType, mimeType, type }) => {
    expect(
      buildChatApiAttachments([
        {
          id: "parameterized-attachment",
          dataUrl: `data:${mediaType};base64,bm90ZXM=`,
          mimeType,
          fileName: "attachment",
        },
      ]),
    ).toEqual([{ type, mimeType, fileName: "attachment", content: "bm90ZXM=" }]);
  },
);

it("serializes supported-size parameterized attachments without losing bytes", () => {
  const content = Buffer.alloc(4 * 1024 * 1024, 0xab).toString("base64");
  expect(
    buildChatApiAttachments([
      {
        id: "large-attachment",
        dataUrl: `data:application/pdf;name=large.pdf;charset=utf-8;base64,${content}`,
        mimeType: "application/pdf",
        fileName: "large.pdf",
      },
    ]),
  ).toEqual([{ type: "file", mimeType: "application/pdf", fileName: "large.pdf", content }]);
});

it.each([
  "data:application/pdf;base64,",
  "data:;base64,QQ==",
  "data:application/pdf;name;base64,QQ==",
  "data:application/pdf;=empty-name;base64,QQ==",
  "data:application/pdf;name=x,broken;base64,QQ==",
  "data:application/pdf;base64;name=x,QQ==",
  "data:application/pdf,QQ==",
])("reports an unavailable payload instead of silently dropping %s", (dataUrl) => {
  expect(() =>
    buildChatApiAttachments([{ id: "broken", dataUrl, mimeType: "application/pdf" }]),
  ).toThrow();
});

it.each(["paste", "file", undefined] as const)(
  "preserves %s origin through queued API recovery without changing attachment bytes",
  (origin) => {
    const submitted = buildChatApiAttachments([
      {
        id: "origin-attachment",
        mimeType: "text/plain",
        fileName: "pasted-text-123.txt",
        dataUrl: "data:text/plain;base64,bm90ZXM=",
        ...(origin ? { origin } : {}),
      },
    ]);
    expect(submitted).toEqual([
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "pasted-text-123.txt",
        content: "bm90ZXM=",
        ...(origin ? { origin } : {}),
      },
    ]);
    expect(buildChatApiAttachments(restoreChatApiAttachments(submitted))).toEqual(submitted);
  },
);
