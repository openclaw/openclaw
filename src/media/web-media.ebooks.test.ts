import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { LocalMediaAccessError, loadWebMedia } from "./web-media.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let fixtureRoot = "";

beforeAll(() => {
  fixtureRoot = tempDirs.make("web-media-ebooks-");
});

async function loadDocumentWithHostRead(fileName: string, body: Buffer | string) {
  const filePath = path.join(fixtureRoot, fileName);
  await fs.writeFile(filePath, body);
  return loadWebMedia(filePath, {
    maxBytes: 1024 * 1024,
    localRoots: "any",
    readFile: async (inputPath) => await fs.readFile(inputPath),
    hostReadCapability: true,
  });
}

async function expectLoadWebMediaErrorCode(promise: Promise<unknown>, code: string) {
  let mediaError: unknown;
  try {
    await promise;
  } catch (error) {
    mediaError = error;
  }
  expect(mediaError).toBeInstanceOf(LocalMediaAccessError);
  expect(mediaError).toMatchObject({ code });
}

describe("host-read ebook documents", () => {
  it("allows buffer-verified host-read EPUB files", async () => {
    const epub = new JSZip();
    epub.file("mimetype", "application/epub+zip", { compression: "STORE" });
    epub.file("META-INF/container.xml", "<container/>");

    const result = await loadDocumentWithHostRead(
      "book.epub",
      await epub.generateAsync({ type: "nodebuffer" }),
    );

    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("application/epub+zip");
  });

  const FICTIONBOOK_NAMESPACE = "http://www.gribuser.ru/xml/fictionbook/2.0";
  const FICTIONBOOK_DOCUMENT =
    '<?xml version="1.0" encoding="utf-8"?>\n<!-- exported -->\n' +
    `<FictionBook xmlns="${FICTIONBOOK_NAMESPACE}" xmlns:l="http://www.w3.org/1999/xlink">` +
    "<description/></FictionBook>";

  it.each(["book.fb2", "book.xml"])(
    "allows validated host-read FictionBook documents for %s",
    async (fileName) => {
      const result = await loadDocumentWithHostRead(fileName, FICTIONBOOK_DOCUMENT);

      expect(result.kind).toBe("document");
      expect(result.contentType).toBe("text/xml");
    },
  );

  it("allows a prefixed FictionBook root behind an XML doctype", async () => {
    const result = await loadDocumentWithHostRead(
      "prefixed.fb2",
      '\uFEFF<?xml version="1.0"?><!DOCTYPE FictionBook>' +
        `<fb:FictionBook xmlns:fb='${FICTIONBOOK_NAMESPACE}'/>`,
    );

    expect(result.kind).toBe("document");
  });

  it.each([
    {
      name: "generic XML with a .xml extension",
      fileName: "settings.xml",
      body: '<?xml version="1.0" encoding="utf-8"?><settings><option name="theme">dark</option></settings>',
    },
    {
      name: "generic XML with a .fb2 extension",
      fileName: "settings.fb2",
      body: '<?xml version="1.0" encoding="utf-8"?><settings><option name="theme">dark</option></settings>',
    },
    {
      name: "a FictionBook root without the FictionBook namespace",
      fileName: "unnamespaced.xml",
      body: '<?xml version="1.0" encoding="utf-8"?><FictionBook><description/></FictionBook>',
    },
    {
      name: "an unprefixed FictionBook root with the namespace on another prefix",
      fileName: "mismatched-default.xml",
      body: '<FictionBook xmlns="urn:not-fictionbook" xmlns:fb="http://www.gribuser.ru/xml/fictionbook/2.0"/>',
    },
    {
      name: "a prefixed FictionBook root with the namespace on another prefix",
      fileName: "mismatched-prefix.fb2",
      body: '<x:FictionBook xmlns:x="urn:not-fictionbook" xmlns:fb="http://www.gribuser.ru/xml/fictionbook/2.0"/>',
    },
    {
      name: "an unprefixed FictionBook root with a namespace decoy inside another attribute",
      fileName: "decoy-default.xml",
      body: `<FictionBook note=' xmlns="${FICTIONBOOK_NAMESPACE}" '/>`,
    },
    {
      name: "a prefixed FictionBook root with a namespace decoy inside another attribute",
      fileName: "decoy-prefix.fb2",
      body: `<x:FictionBook xmlns:x="urn:not-fictionbook" note=' xmlns:x="${FICTIONBOOK_NAMESPACE}" '/>`,
    },
    {
      name: "a FictionBook element nested below a foreign root",
      fileName: "wrapped.xml",
      body: '<?xml version="1.0"?><settings><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"/></settings>',
    },
  ])("rejects text-valid host-read $name", async ({ fileName, body }) => {
    await expectLoadWebMediaErrorCode(loadDocumentWithHostRead(fileName, body), "path-not-allowed");
  });

  it("rejects binary data disguised as a FictionBook file", async () => {
    const filePath = path.join(fixtureRoot, "not-a-book.fb2");
    await fs.writeFile(filePath, Buffer.from([0, 0xff, 0x10, 0x80]));

    await expectLoadWebMediaErrorCode(
      loadWebMedia(filePath, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (inputPath) => await fs.readFile(inputPath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });
});
