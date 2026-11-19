import { expect, it } from "vitest";
import { readTranscriptMediaEntries } from "./message-extract.ts";

it("reads persisted media through the browser transcript entry point", () => {
  expect(
    readTranscriptMediaEntries({
      role: "user",
      __openclaw: {
        media: [{ path: "/synthetic/attachment.png", contentType: "image/png" }],
      },
    }),
  ).toEqual([
    {
      factIndex: 0,
      path: "/synthetic/attachment.png",
      mediaType: "image/png",
      fileName: undefined,
    },
  ]);
});
