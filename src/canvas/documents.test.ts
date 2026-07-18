// Core Canvas document storage and URL contract coverage.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCanvasDocumentEntryUrl,
  createCanvasDocument,
  resolveCanvasDocumentAssets,
  resolveCanvasDocumentDir,
  resolveCanvasHttpPathToLocalPath,
} from "./documents.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(label = "openclaw-canvas-documents-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), label));
  tempDirs.push(dir);
  return dir;
}

describe("canvas documents", () => {
  it("builds entry urls for materialized path documents under managed storage", async () => {
    const stateDir = await createTempDir();
    const workspaceDir = await createTempDir("openclaw-canvas-documents-workspace-");
    await mkdir(path.join(workspaceDir, "player"), { recursive: true });
    await writeFile(path.join(workspaceDir, "player/index.html"), "<div>ok</div>", "utf8");

    const document = await createCanvasDocument(
      {
        kind: "html_bundle",
        entrypoint: { type: "path", value: "player/index.html" },
      },
      { stateDir, workspaceDir },
    );

    expect(document.entryUrl).toContain("/__openclaw__/canvas/documents/");
    expect(document.localEntrypoint).toBe("index.html");
    expect(resolveCanvasDocumentDir(document.id, { stateDir })).toContain(stateDir);
  });

  it("normalizes nested local entrypoint urls", () => {
    expect(buildCanvasDocumentEntryUrl("cv_example", "collection.media/index.html")).toBe(
      "/__openclaw__/canvas/documents/cv_example/collection.media/index.html",
    );
  });

  it("encodes special characters in hosted entrypoint path segments", () => {
    expect(buildCanvasDocumentEntryUrl("cv_example", "bundle#1/entry%20point?.html")).toBe(
      "/__openclaw__/canvas/documents/cv_example/bundle%231/entry%2520point%3F.html",
    );
  });

  it("materializes inline html bundles as index documents", async () => {
    const stateDir = await createTempDir();
    const document = await createCanvasDocument(
      {
        kind: "html_bundle",
        title: "Preview",
        entrypoint: {
          type: "html",
          value:
            "<!doctype html><html><head><style>.demo{color:red}</style></head><body><div class='demo'>Front</div></body></html>",
        },
      },
      { stateDir },
    );

    const indexHtml = await readFile(
      path.join(resolveCanvasDocumentDir(document.id, { stateDir }), "index.html"),
      "utf8",
    );
    expect(indexHtml).toContain("<div class='demo'>Front</div>");
    expect(indexHtml).toContain("<style>.demo{color:red}</style>");
    expect(document.title).toBe("Preview");
    expect(document.entryUrl).toBe(`/__openclaw__/canvas/documents/${document.id}/index.html`);
  });

  it("reuses a supplied stable id by replacing the prior materialized view", async () => {
    const stateDir = await createTempDir();
    const first = await createCanvasDocument(
      {
        id: "status-card",
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<div>first</div>" },
      },
      { stateDir },
    );
    const second = await createCanvasDocument(
      {
        id: "status-card",
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<div>second</div>" },
      },
      { stateDir },
    );

    expect(first.id).toBe("status-card");
    expect(second.id).toBe("status-card");
    const indexHtml = await readFile(
      path.join(resolveCanvasDocumentDir(second.id, { stateDir }), "index.html"),
      "utf8",
    );
    expect(indexHtml).toContain("second");
    expect(indexHtml).not.toContain("first");
  });

  it("exposes stable managed asset urls for copied assets", async () => {
    const stateDir = await createTempDir();
    const workspaceDir = await createTempDir("openclaw-canvas-documents-workspace-");
    await mkdir(path.join(workspaceDir, "collection.media"), { recursive: true });
    await writeFile(path.join(workspaceDir, "collection.media/audio.mp3"), "audio", "utf8");
    const document = await createCanvasDocument(
      {
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<audio></audio>" },
        assets: [
          {
            logicalPath: "collection.media/audio.mp3",
            sourcePath: "collection.media/audio.mp3",
            contentType: "audio/mpeg",
          },
        ],
      },
      { stateDir, workspaceDir },
    );

    expect(resolveCanvasDocumentAssets(document, { stateDir })).toEqual([
      {
        logicalPath: "collection.media/audio.mp3",
        contentType: "audio/mpeg",
        localPath: path.join(
          resolveCanvasDocumentDir(document.id, { stateDir }),
          "collection.media/audio.mp3",
        ),
        url: `/__openclaw__/canvas/documents/${document.id}/collection.media/audio.mp3`,
      },
    ]);
    expect(
      resolveCanvasDocumentAssets(document, {
        baseUrl: "http://127.0.0.1:19003",
        stateDir,
      }),
    ).toEqual([
      {
        logicalPath: "collection.media/audio.mp3",
        contentType: "audio/mpeg",
        localPath: path.join(
          resolveCanvasDocumentDir(document.id, { stateDir }),
          "collection.media/audio.mp3",
        ),
        url: `http://127.0.0.1:19003/__openclaw__/canvas/documents/${document.id}/collection.media/audio.mp3`,
      },
    ]);
  });

  it("wraps local and remote PDF documents in index viewer pages", async () => {
    const stateDir = await createTempDir();
    const workspaceDir = await createTempDir("openclaw-canvas-documents-workspace-");
    await writeFile(path.join(workspaceDir, "demo.pdf"), "%PDF-1.4", "utf8");
    const localDocument = await createCanvasDocument(
      { kind: "document", entrypoint: { type: "path", value: "demo.pdf" } },
      { stateDir, workspaceDir },
    );
    const remoteDocument = await createCanvasDocument(
      {
        kind: "document",
        entrypoint: { type: "url", value: "https://example.com/demo.pdf" },
      },
      { stateDir },
    );

    const localHtml = await readFile(
      path.join(resolveCanvasDocumentDir(localDocument.id, { stateDir }), "index.html"),
      "utf8",
    );
    const remoteHtml = await readFile(
      path.join(resolveCanvasDocumentDir(remoteDocument.id, { stateDir }), "index.html"),
      "utf8",
    );
    expect(localHtml).toContain('data="demo.pdf"');
    expect(remoteHtml).toContain('data="https://example.com/demo.pdf"');
  });

  it("rejects traversal and malformed encoded hosted paths", async () => {
    const stateDir = await createTempDir();
    expect(
      resolveCanvasHttpPathToLocalPath(
        "/__openclaw__/canvas/documents/../collection.media/index.html",
        { stateDir },
      ),
    ).toBeNull();

    const documentDir = resolveCanvasDocumentDir("cv_malformed", { stateDir });
    await mkdir(documentDir, { recursive: true });
    await writeFile(path.join(documentDir, "%E0%A4%A.html"), "literal-percent-name", "utf8");
    expect(
      resolveCanvasHttpPathToLocalPath(
        "/__openclaw__/canvas/documents/cv_malformed/%E0%A4%A.html",
        { stateDir },
      ),
    ).toBeNull();
    expect(
      resolveCanvasHttpPathToLocalPath(
        "/__openclaw__/canvas/documents/cv_malformed/%25E0%25A4%25A.html",
        { stateDir },
      ),
    ).toBe(path.join(documentDir, "%E0%A4%A.html"));
  });
});
