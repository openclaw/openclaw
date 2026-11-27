import { link, rename, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import {
  createCanvasDocument,
  readCanvasDocumentHtmlSource as readHtml,
  resolveCanvasDocumentsDir,
  resolveCanvasHttpPathToLocalPath,
} from "./documents.js";
import { handleCanvasDocumentHttpRequest } from "./serve.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-canvas-documents-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});
afterEach(() => vi.unstubAllEnvs());

const documentPath = (id: string, file = "") =>
  path.join(resolveCanvasDocumentsDir(stateDir), id, file);
const hostedPath = (suffix: string) =>
  resolveCanvasHttpPathToLocalPath(`/__openclaw__/canvas/documents/${suffix}`);

describe("canvas documents", () => {
  it.skipIf(process.platform === "win32").each(["document", "manifest.json", "index.html"])(
    "rejects a symlinked %s when reading widget HTML",
    async (target) => {
      const outsideDir = tempDirs.make("openclaw-canvas-outside-");
      const document = await createCanvasDocument({ html: "<p>outside</p>" });
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
      const document = await createCanvasDocument({ html: "<p>aliased</p>" });
      await link(documentPath(document.id, target), path.join(stateDir, `alias-${target}`));
      await expect(readHtml(document.id)).rejects.toMatchObject({ code: "hardlink" });
    },
  );

  it("bounds HTML reads by bytes while independently allowing the manifest", async () => {
    const html = "é".repeat(5 * 1024 * 1024);
    const document = await createCanvasDocument({ html: `${html}é` });
    await expect(readHtml(document.id)).rejects.toMatchObject({ code: "too-large" });
    const bounded = await createCanvasDocument({ html });
    await expect(readHtml(bounded.id)).resolves.toEqual({ html });
  });

  it("rejects oversized manifests before parsing them", async () => {
    const document = await createCanvasDocument({ html: "<p>small</p>" });
    await writeFile(
      documentPath(document.id, "manifest.json"),
      JSON.stringify({ ...document, title: "x".repeat(2 * 1024 * 1024) }),
    );
    await expect(readHtml(document.id)).rejects.toMatchObject({ code: "too-large" });
  });

  it("rejects traversal and malformed encoded hosted paths", async () => {
    expect(hostedPath("../collection.media/index.html")).toBeNull();

    const documentDir = documentPath("cv_malformed");
    expect(hostedPath("cv_malformed/%E0%A4%A.html")).toBeNull();
    expect(hostedPath("cv_malformed/%25E0%25A4%25A.html")).toBe(
      path.join(documentDir, "%E0%A4%A.html"),
    );
  });
});

async function capture(url: string, method = "GET") {
  const response = createMockServerResponse();
  const handled = await handleCanvasDocumentHttpRequest(
    { method, url } as IncomingMessage,
    response,
  );
  const body = Buffer.from(response.body ?? "");
  return {
    handled,
    statusCode: response.statusCode,
    getHeader: (name: string) => response.getHeader(name),
    body,
    text: body.toString("utf8"),
  };
}

async function expectHead(url: string) {
  const get = await capture(url);
  const head = await capture(url, "HEAD");
  expect([get.statusCode, head.statusCode, head.body.byteLength]).toEqual([200, 200, 0]);
  expect(head.getHeader("content-length")).toBe(String(get.body.byteLength));
  return { get, head };
}

describe("core canvas document host", () => {
  it("serves sandboxed HTML and asset GET/HEAD responses with exact byte lengths", async () => {
    const html = "<html><body>widget</body></html>";
    const document = await createCanvasDocument({ html, title: "Preview", cspSandbox: "scripts" });
    expect(document.title).toBe("Preview");
    expect(document.entryUrl).toBe(`/__openclaw__/canvas/documents/${document.id}/index.html`);
    await expect(readHtml(document.id)).resolves.toEqual({ html, cspSandbox: "scripts" });
    const response = await capture(document.entryUrl);
    expect(response).toMatchObject({ handled: true, statusCode: 200, text: html });
    expect(["content-type", "cache-control", "referrer-policy"].map(response.getHeader)).toEqual([
      "text/html; charset=utf-8",
      "no-store",
      "no-referrer",
    ]);
    const csp = String(response.getHeader("content-security-policy"));
    const scripts = csp.split(";").find((directive) => directive.trim().startsWith("script-src "));
    expect(scripts?.split(/\s+/)).toContain("'self'");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("connect-src 'none'");
    const documentUrl = (file: string) => `/__openclaw__/canvas/documents/${document.id}/${file}`;
    const file = (name: string) => documentPath(document.id, name);
    await writeFile(file("style.css"), "body { color: red; }", "utf8");

    const { get: getHtml, head: headHtml } = await expectHead(document.entryUrl);
    expect(headHtml.getHeader("content-type")).toBe("text/html; charset=utf-8");
    expect(headHtml.getHeader("content-security-policy")).toBe(
      getHtml.getHeader("content-security-policy"),
    );

    await expectHead(documentUrl("style.css"));

    // Invalid UTF-8 in a copied HTML file expands to U+FFFD when served, so the
    // header must be measured from the decoded representation, not raw bytes.
    const brokenBytes = Buffer.from([0xff, 0xfe]);
    await writeFile(file("broken.html"), brokenBytes);
    const { get: getBroken } = await expectHead(documentUrl("broken.html"));
    expect(getBroken.body.byteLength).toBeGreaterThan(brokenBytes.byteLength);
  });

  it("omits the sandbox response header for unmarked documents", async () => {
    const document = await createCanvasDocument({ html: "<html><body>plain</body></html>" });

    const response = await capture(document.entryUrl);
    expect(response.statusCode).toBe(200);
    expect(response.getHeader("content-security-policy")).toBeUndefined();
  });

  it.each([
    ["POST", "missing/index.html", { statusCode: 405, text: "Method Not Allowed" }],
    ["GET", "../widget-1/index.html", { handled: false }],
    ["GET", "missing/index.html", { statusCode: 404, text: "not found" }],
  ] as const)("rejects %s %s", async (method, suffix, expected) => {
    expect(await capture(`/__openclaw__/canvas/documents/${suffix}`, method)).toMatchObject(
      expected,
    );
  });
});
