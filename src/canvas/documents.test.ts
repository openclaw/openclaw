import fs, { link, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createCanvasDocument,
  readCanvasDocumentHtmlSource as readHtml,
  resolveCanvasDocumentsDir,
  resolveCanvasHttpPathToLocalPath,
} from "./documents.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-canvas-documents-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});
afterEach(() => vi.unstubAllEnvs());

function documentPath(id: string, file = "") {
  return path.join(resolveCanvasDocumentsDir(stateDir), id, file);
}
const hostedPath = (suffix: string) =>
  resolveCanvasHttpPathToLocalPath(`/__openclaw__/canvas/documents/${suffix}`);

function createHtmlDocument(
  html: string,
  options: Pick<Parameters<typeof createCanvasDocument>[0], "id" | "title" | "cspSandbox"> = {},
) {
  return createCanvasDocument({ html, ...options }, { stateDir });
}

describe("canvas documents", () => {
  it.skipIf(process.platform === "win32").each(["document", "manifest.json", "index.html"])(
    "rejects a symlinked %s when reading widget HTML",
    async (target) => {
      const outsideDir = tempDirs.make("openclaw-canvas-outside-");
      const document = await createHtmlDocument("<p>outside</p>");
      const documentDir = documentPath(document.id);
      const original = target === "document" ? documentDir : path.join(documentDir, target);
      const outside = path.join(outsideDir, target);
      await rename(original, outside);
      await symlink(outside, original, target === "document" ? "dir" : "file");

      await expect(readHtml(document.id)).rejects.toMatchObject({
        code: target === "document" ? "outside-workspace" : "symlink",
      });
    },
  );

  it.each(["manifest.json", "index.html"])(
    "rejects a hardlinked %s when reading widget HTML",
    async (target) => {
      const document = await createHtmlDocument("<p>aliased</p>");
      await link(documentPath(document.id, target), path.join(stateDir, `alias-${target}`));
      await expect(readHtml(document.id)).rejects.toMatchObject({ code: "hardlink" });
    },
  );

  it("bounds HTML reads by bytes while independently allowing the manifest", async () => {
    const html = "é".repeat(5 * 1024 * 1024);
    const document = await createHtmlDocument(`${html}é`);
    await expect(readHtml(document.id)).rejects.toMatchObject({ code: "too-large" });
    await createHtmlDocument(html, { id: document.id });
    await expect(readHtml(document.id)).resolves.toEqual({ html });
  });

  it("rejects oversized manifests before parsing them", async () => {
    const document = await createHtmlDocument("<p>small</p>");
    await writeFile(
      documentPath(document.id, "manifest.json"),
      JSON.stringify({ ...document, title: "x".repeat(2 * 1024 * 1024) }),
    );
    await expect(readHtml(document.id)).rejects.toMatchObject({ code: "too-large" });
  });

  it("materializes inline html bundles as index documents", async () => {
    const html = "<style>.demo{color:red}</style><div class='demo'>Front</div>";
    const document = await createHtmlDocument(html, { title: "Preview" });
    const indexHtml = await readFile(documentPath(document.id, "index.html"), "utf8");
    expect(indexHtml).toBe(html);
    expect(document.title).toBe("Preview");
    expect(document.entryUrl).toBe(`/__openclaw__/canvas/documents/${document.id}/index.html`);
    await expect(readHtml(document.id)).resolves.toEqual({ html: indexHtml });
  });

  it("reports the document sandbox policy alongside board source bytes", async () => {
    const document = await createHtmlDocument("<script>ready()</script>", {
      cspSandbox: "scripts",
    });

    await expect(readHtml(document.id)).resolves.toEqual({
      html: "<script>ready()</script>",
      cspSandbox: "scripts",
    });
  });

  it("reuses a supplied stable id by replacing the prior materialized view", async () => {
    const first = await createHtmlDocument("<div>first</div>", { id: "status-card" });
    const second = await createHtmlDocument("<div>second</div>", { id: "status-card" });

    expect([first.id, second.id]).toEqual(["status-card", "status-card"]);
    const indexHtml = await readFile(documentPath(second.id, "index.html"), "utf8");
    expect(indexHtml).toContain("second");
    expect(indexHtml).not.toContain("first");
  });

  it("does not overwrite an existing document when removing it fails", async () => {
    const id = "status-card";
    await createHtmlDocument("<div>first</div>", { id });
    const failure = Object.assign(new Error("document directory busy"), { code: "EBUSY" });
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(failure);
    try {
      await expect(createHtmlDocument("<div>second</div>", { id })).rejects.toBe(failure);
      await expect(readHtml(id)).resolves.toEqual({ html: "<div>first</div>" });
    } finally {
      remove.mockRestore();
    }
  });

  it("rejects traversal and malformed encoded hosted paths", async () => {
    expect(hostedPath("../collection.media/index.html")).toBeNull();

    const documentDir = documentPath("cv_malformed");
    await mkdir(documentDir, { recursive: true });
    await writeFile(path.join(documentDir, "%E0%A4%A.html"), "literal-percent-name", "utf8");
    expect(hostedPath("cv_malformed/%E0%A4%A.html")).toBeNull();
    expect(hostedPath("cv_malformed/%25E0%25A4%25A.html")).toBe(
      path.join(documentDir, "%E0%A4%A.html"),
    );
  });
});
