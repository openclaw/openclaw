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
const greeting = "Привет €";
const legacyText = "Café notes: résumé et météo pour demain.";
function prepareText(mime: string, encoding: BufferEncoding = "latin1") {
  return prepareAttachment({
    base64: Buffer.from(legacyText, encoding).toString("base64"),
    label: "notes.txt",
    mime,
  });
}

async function localDocument(text: string | Buffer, name: string, mime: string, named = false) {
  const workspaceDir = tempDirs.make("openclaw-document-context-");
  const mediaPath = path.join(workspaceDir, name);
  await fs.writeFile(mediaPath, text);
  const ctx: MsgContext = {
    Body: "see attached",
    media: [{ path: mediaPath, contentType: mime, ...(named ? { fileName: name } : {}) }],
  };
  return { ctx, workspaceDir, cfg: {} };
}

describe("remote document charset", () => {
  const cyrillic = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0x88]);
  const transportCharset = "text/plain; charset=windows-1251";
  const channelCharset = "text/plain; charset=windows-1252";
  const unknownCharset = "text/plain; charset=not-an-encoding";
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(greeting, "utf16le")]);
  const cases: [string, Buffer, string, string, string?][] = [
    ["transport charset", cyrillic, transportCharset, greeting],
    ["quoted transport alias", cyrillic, 'text/plain; charset="cp1251"', greeting],
    ["channel type without charset", cyrillic, transportCharset, greeting, "text/plain"],
    ["channel charset precedence", cyrillic, transportCharset, "Ïðèâåò ˆ", channelCharset],
    ["byte-detected UTF-16", utf16, transportCharset, greeting],
    ["UTF-8 default", Buffer.from(greeting), "text/plain", greeting],
    ["unknown charset fallback", Buffer.from(greeting), unknownCharset, greeting],
    ["inferred legacy text", Buffer.from(legacyText, "latin1"), "text/plain", legacyText],
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
          response.writeHead(200, { "Content-Type": entry[2] });
          response.end(entry[1]);
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

  it.each(cases)(
    "decodes %s through the real remote attachment owner",
    async (name, _buffer, _header, expected, mime) => {
      const attachment = {
        index: 0,
        url: `http://127.0.0.1:${fixture.claim.port}/${cases.findIndex((entry) => entry[0] === name)}.txt`,
        mime,
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
        expect(result.blocks[0]?.text).toContain(`\n---\n${expected}\n`);
        expect(result.images).toEqual([]);
      } finally {
        await cache.cleanup();
      }
    },
  );
});

describe("renderInboundDocumentContext", () => {
  it.each(["", " Application/Octet-Stream; charset=binary "])(
    "retains inferred legacy encoding through prepared content type %j",
    async (mime) => {
      const prepared = await prepareText(mime);
      const context = await renderInboundDocumentContext(
        await localDocument(Buffer.from(legacyText, "latin1"), "notes.txt", prepared.mime, true),
      );

      expect(prepared.mime).toBe("text/plain; charset=windows-1252");
      expect(context.text).toContain(legacyText);
      expect(context.text).not.toContain("\uFFFD");
    },
  );

  it.each([
    ["utf8", ""],
    ["latin1", "text/plain"],
    ["latin1", "text/plain; charset=utf-8"],
  ] as const)("keeps prepared MIME for %s with %s", async (encoding, mime) => {
    expect(await prepareText(mime, encoding)).toMatchObject({ mime: "text/plain" });
  });

  it.each<[string, number | undefined, string, boolean]>([
    ["document body for the steered run", undefined, "document body for the steered run", false],
    ["document body for the steered run", 13, "document body", true],
    ["雪🙂", 4, "雪🙂", false],
    ["雪🙂!", 4, "雪🙂!", false],
    ["雪🙂!tail", 4, "雪🙂!", true],
    ["雪🙂tail", 2, "雪", true],
    ["not empty", 0, "", true],
  ])("renders %s at %s without mutation", async (text, maxChars, expected, truncated) => {
    const params = await localDocument(text, "steer-note.txt", "text/plain");
    const original = structuredClone(params.ctx);

    const context = await renderInboundDocumentContext({ ...params, maxChars });

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
    expect(params.ctx).toEqual(original);
  });
});
