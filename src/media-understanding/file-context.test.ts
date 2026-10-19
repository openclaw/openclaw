import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { prepareAttachment } from "../media/attachment-processor.runtime.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { MediaAttachmentCache } from "./attachments.cache.js";
import { extractFileContext, renderInboundDocumentContext } from "./file-context.js";
import { resolveFileExtractionLimits } from "./file-extraction-limits.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("remote document charset", () => {
  const cyrillic = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0x88]);
  const cases = [
    {
      name: "transport charset",
      buffer: cyrillic,
      header: "text/plain; charset=windows-1251",
      expected: "Привет €",
    },
    {
      name: "quoted transport alias",
      buffer: cyrillic,
      header: 'text/plain; charset="cp1251"',
      expected: "Привет €",
    },
    {
      name: "channel type without charset",
      buffer: cyrillic,
      header: "text/plain; charset=windows-1251",
      mime: "text/plain",
      expected: "Привет €",
    },
    {
      name: "channel charset precedence",
      buffer: cyrillic,
      header: "text/plain; charset=windows-1251",
      mime: "text/plain; charset=windows-1252",
      expected: "Ïðèâåò ˆ",
    },
    {
      name: "byte-detected UTF-16",
      buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Привет €", "utf16le")]),
      header: "text/plain; charset=windows-1251",
      expected: "Привет €",
    },
    {
      name: "UTF-8 default",
      buffer: Buffer.from("Привет €"),
      header: "text/plain",
      expected: "Привет €",
    },
    {
      name: "unknown charset fallback",
      buffer: Buffer.from("Привет €"),
      header: "text/plain; charset=not-an-encoding",
      expected: "Привет €",
    },
    {
      name: "inferred legacy text",
      buffer: Buffer.from("Café notes: résumé et météo pour demain.", "latin1"),
      header: "text/plain",
      expected: "Café notes: résumé et météo pour demain.",
    },
  ];
  let fixture: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;

  beforeAll(async () => {
    fixture = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          const index = Number(request.url?.slice(1).split(".")[0]);
          const entry = cases[index];
          if (!entry) {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, { "Content-Type": entry.header });
          response.end(entry.buffer);
        }),
    });
  });

  afterAll(async () => {
    fixture.listener.closeAllConnections();
    try {
      await fixture.releaseListener();
    } finally {
      await fixture.claim.release();
    }
  });

  it.each(cases)("decodes $name through the real remote attachment owner", async (entry) => {
    const attachment = {
      index: 0,
      url: `http://127.0.0.1:${fixture.claim.port}/${cases.indexOf(entry)}.txt`,
      mime: entry.mime,
    };
    const cache = new MediaAttachmentCache([attachment], {
      includeDefaultLocalPathRoots: false,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    try {
      const result = await extractFileContext({
        attachments: [attachment],
        cache,
        cfg: {},
        limits: resolveFileExtractionLimits({}),
        selfServePathsEnabled: false,
      });
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]?.text).toContain(`\n---\n${entry.expected}\n`);
      expect(result.images).toEqual([]);
    } finally {
      await cache.cleanup();
    }
  });
});

describe("renderInboundDocumentContext", () => {
  it.each(["", " Application/Octet-Stream; charset=binary "])(
    "retains inferred legacy encoding through prepared content type %j",
    async (mime) => {
      const workspaceDir = tempDirs.make("openclaw-prepared-document-");
      const mediaPath = path.join(workspaceDir, "notes.txt");
      const text = "Café notes: résumé et météo pour demain.";
      const buffer = Buffer.from(text, "latin1");
      const prepared = await prepareAttachment({
        base64: buffer.toString("base64"),
        label: "notes.txt",
        mime,
      });
      await fs.writeFile(mediaPath, buffer);
      const ctx: MsgContext = {
        media: [{ path: mediaPath, contentType: prepared.mime, fileName: "notes.txt" }],
      };

      const context = await renderInboundDocumentContext({ ctx, cfg: {}, workspaceDir });

      expect(prepared.mime).toBe("text/plain; charset=windows-1252");
      expect(context.text).toContain(text);
      expect(context.text).not.toContain("\uFFFD");
    },
  );

  it.each([
    { encoding: "utf8", mime: "", expectedMime: "text/plain" },
    { encoding: "latin1", mime: "text/plain", expectedMime: "text/plain" },
    { encoding: "latin1", mime: "text/plain; charset=utf-8", expectedMime: "text/plain" },
  ] as const)("keeps existing prepared MIME for $encoding with $mime", async (input) => {
    const prepared = await prepareAttachment({
      base64: Buffer.from("Café notes: résumé et météo pour demain.", input.encoding).toString(
        "base64",
      ),
      label: "notes.txt",
      mime: input.mime,
    });

    expect(prepared.mime).toBe(input.expectedMime);
  });

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
