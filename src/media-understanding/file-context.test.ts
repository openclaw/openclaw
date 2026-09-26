import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { renderInboundDocumentContext } from "./file-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("renderInboundDocumentContext", () => {
  it.each([
    {
      text: "document body for the steered run",
      maxChars: undefined,
      expected: "document body for the steered run",
      truncated: false,
    },
    {
      text: "document body for the steered run",
      maxChars: 13,
      expected: "document body",
      truncated: true,
    },
    { text: "雪🙂", maxChars: 4, expected: "雪🙂", truncated: false },
    { text: "雪🙂!", maxChars: 4, expected: "雪🙂!", truncated: false },
    { text: "雪🙂!tail", maxChars: 4, expected: "雪🙂!", truncated: true },
    { text: "雪🙂tail", maxChars: 2, expected: "雪", truncated: true },
    { text: "not empty", maxChars: 0, expected: "", truncated: true },
  ])(
    "renders actual attachment text without mutating input at limit $maxChars for $text",
    async ({ text, maxChars, expected, truncated }) => {
      const workspaceDir = tempDirs.make("openclaw-document-context-");
      const mediaPath = path.join(workspaceDir, "steer-note.txt");
      await fs.writeFile(mediaPath, text);
      const ctx: MsgContext = {
        Body: "see attached",
        media: [{ path: mediaPath, contentType: "text/plain" }],
      };
      const original = structuredClone(ctx);

      const context = await renderInboundDocumentContext({ ctx, cfg: {}, workspaceDir, maxChars });

      expect(context.text).toContain('<file name="steer-note.txt" mime="text/plain">');
      expect(context.text).toContain(`\n---\n${expected}\n`);
      expect(context.text).not.toContain("[No extractable text]");
      expect(context.text).not.toContain("\uFFFD");
      if (!truncated) {
        expect(context.text).not.toContain("[Partial document:");
      } else {
        expect(context.text).toContain("[Partial document: text truncated.]");
        expect(context.text).not.toContain("for the steered run");
        expect(context.text.indexOf("[Partial document:")).toBeLessThan(
          context.text.indexOf("<<<EXTERNAL_UNTRUSTED_CONTENT"),
        );
      }
      expect(context.images).toEqual([]);
      // Rejected steering must leave the original input available for normal dispatch.
      expect(ctx).toEqual(original);
    },
  );
});
