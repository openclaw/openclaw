// Core Canvas document storage and URL contract coverage.
import fs, { link, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createCanvasDocument,
  readCanvasDocumentHtmlSource,
  resolveCanvasDocumentsDir,
  resolveCanvasHttpPathToLocalPath,
} from "./documents.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function resolveCanvasDocumentDir(stateDir: string, documentId: string): string {
  return path.join(resolveCanvasDocumentsDir(stateDir), documentId);
}

function createHtmlDocument(
  stateDir: string,
  html: string,
  options: Pick<Parameters<typeof createCanvasDocument>[0], "id" | "title" | "cspSandbox"> = {},
) {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return createCanvasDocument({ html, ...options }, { stateDir });
}

describe("canvas documents", () => {
  it.skipIf(process.platform === "win32").each(["document", "manifest.json", "index.html"])(
    "rejects a symlinked %s when reading widget HTML",
    async (target) => {
      const stateDir = tempDirs.make("openclaw-canvas-links-");
      const outsideDir = tempDirs.make("openclaw-canvas-outside-");
      const document = await createHtmlDocument(stateDir, "<p>outside</p>");
      const documentDir = resolveCanvasDocumentDir(stateDir, document.id);
      const original = target === "document" ? documentDir : path.join(documentDir, target);
      const outside = path.join(outsideDir, target);
      await rename(original, outside);
      await symlink(outside, original, target === "document" ? "dir" : "file");

      await expect(readCanvasDocumentHtmlSource(document.id)).rejects.toMatchObject({
        code: target === "document" ? "outside-workspace" : "symlink",
      });
    },
  );

  it.each(["manifest.json", "index.html"])(
    "rejects a hardlinked %s when reading widget HTML",
    async (target) => {
      const stateDir = tempDirs.make("openclaw-canvas-hardlinks-");
      const document = await createHtmlDocument(stateDir, "<p>aliased</p>");
      await link(
        path.join(resolveCanvasDocumentDir(stateDir, document.id), target),
        path.join(stateDir, `alias-${target}`),
      );
      await expect(readCanvasDocumentHtmlSource(document.id)).rejects.toMatchObject({
        code: "hardlink",
      });
    },
  );

  it("bounds HTML reads by bytes while independently allowing the manifest", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-bounded-");
    const html = "é".repeat(5 * 1024 * 1024);
    const document = await createHtmlDocument(stateDir, `${html}é`);
    await expect(readCanvasDocumentHtmlSource(document.id)).rejects.toMatchObject({
      code: "too-large",
    });
    await createHtmlDocument(stateDir, html, { id: document.id });
    await expect(readCanvasDocumentHtmlSource(document.id)).resolves.toEqual({ html });
  });

  it("rejects oversized manifests before parsing them", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-manifest-");
    const document = await createHtmlDocument(stateDir, "<p>small</p>");
    const manifestPath = path.join(
      resolveCanvasDocumentDir(stateDir, document.id),
      "manifest.json",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({ ...document, title: "x".repeat(2 * 1024 * 1024) }),
    );
    await expect(readCanvasDocumentHtmlSource(document.id)).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("materializes inline html bundles as index documents", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const document = await createHtmlDocument(
      stateDir,
      "<!doctype html><html><head><style>.demo{color:red}</style></head><body><div class='demo'>Front</div></body></html>",
      { title: "Preview" },
    );

    const indexHtml = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, document.id), "index.html"),
      "utf8",
    );
    expect(indexHtml).toContain("<div class='demo'>Front</div>");
    expect(indexHtml).toContain("<style>.demo{color:red}</style>");
    expect(document.title).toBe("Preview");
    expect(document.entryUrl).toBe(`/__openclaw__/canvas/documents/${document.id}/index.html`);
    await expect(readCanvasDocumentHtmlSource(document.id)).resolves.toEqual({
      html: indexHtml,
    });
  });

  it("reports the document sandbox policy alongside board source bytes", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const document = await createHtmlDocument(stateDir, "<script>ready()</script>", {
      cspSandbox: "scripts",
    });

    await expect(readCanvasDocumentHtmlSource(document.id)).resolves.toEqual({
      html: "<script>ready()</script>",
      cspSandbox: "scripts",
    });
  });

  it("reuses a supplied stable id by replacing the prior materialized view", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const first = await createHtmlDocument(stateDir, "<div>first</div>", { id: "status-card" });
    const second = await createHtmlDocument(stateDir, "<div>second</div>", { id: "status-card" });

    expect(first.id).toBe("status-card");
    expect(second.id).toBe("status-card");
    const indexHtml = await readFile(
      path.join(resolveCanvasDocumentDir(stateDir, second.id), "index.html"),
      "utf8",
    );
    expect(indexHtml).toContain("second");
    expect(indexHtml).not.toContain("first");
  });

  it("does not overwrite an existing document when removing it fails", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    const id = "status-card";
    await createHtmlDocument(stateDir, "<div>first</div>", { id });
    const failure = Object.assign(new Error("document directory busy"), { code: "EBUSY" });
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(failure);
    try {
      await expect(createHtmlDocument(stateDir, "<div>second</div>", { id })).rejects.toBe(failure);
      await expect(readCanvasDocumentHtmlSource(id)).resolves.toEqual({
        html: "<div>first</div>",
      });
    } finally {
      remove.mockRestore();
    }
  });

  it("rejects traversal and malformed encoded hosted paths", async () => {
    const stateDir = tempDirs.make("openclaw-canvas-documents-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    expect(
      resolveCanvasHttpPathToLocalPath(
        "/__openclaw__/canvas/documents/../collection.media/index.html",
      ),
    ).toBeNull();

    const documentDir = resolveCanvasDocumentDir(stateDir, "cv_malformed");
    await mkdir(documentDir, { recursive: true });
    await writeFile(path.join(documentDir, "%E0%A4%A.html"), "literal-percent-name", "utf8");
    expect(
      resolveCanvasHttpPathToLocalPath("/__openclaw__/canvas/documents/cv_malformed/%E0%A4%A.html"),
    ).toBeNull();
    expect(
      resolveCanvasHttpPathToLocalPath(
        "/__openclaw__/canvas/documents/cv_malformed/%25E0%25A4%25A.html",
      ),
    ).toBe(path.join(documentDir, "%E0%A4%A.html"));
  });
});
