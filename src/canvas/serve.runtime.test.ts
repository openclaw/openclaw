import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCanvasDocument, resolveCanvasDocumentsDir } from "./documents.js";
import { handleCanvasDocumentHttpRequest } from "./serve.runtime.js";
import { buildWidgetDocument } from "./wrap.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-canvas-serve-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});
afterEach(() => vi.unstubAllEnvs());
const documentUrl = (file = "index.html") => `/__openclaw__/canvas/documents/widget-1/${file}`;

async function createHtmlDocument(html: string, cspSandbox?: "scripts") {
  const document = await createCanvasDocument({ id: "widget-1", html, cspSandbox }, { stateDir });
  return { document };
}

async function capture(url: string, method = "GET") {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, number | string | string[]>,
    body: Buffer.alloc(0) as Buffer,
    setHeader(name: string, value: number | string | readonly string[]) {
      this.headers[name.toLowerCase()] = typeof value === "object" ? [...value] : value;
      return this;
    },
    end(chunk?: string | Buffer) {
      this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
      return this;
    },
  };
  const handled = await handleCanvasDocumentHttpRequest(
    { method, url } as IncomingMessage,
    response as unknown as ServerResponse,
  );
  return { handled, ...response, text: response.body.toString("utf8") };
}

async function expectHead(url: string) {
  const get = await capture(url);
  const head = await capture(url, "HEAD");
  expect([get.statusCode, head.statusCode, head.body.byteLength]).toEqual([200, 200, 0]);
  expect(head.headers["content-length"]).toBe(String(get.body.byteLength));
  return { get, head };
}

describe("core canvas document host", () => {
  it.each([
    [
      "stored",
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'self'"><script src="/__openclaw__/a2ui/a2ui.bundle.js"></script>`,
    ],
    [
      "new",
      buildWidgetDocument(
        "Registered renderer",
        '<script src="/__openclaw__/a2ui/a2ui-v0.9.bundle.js"></script>',
        { scriptOrigins: ["'self'"] },
      ),
    ],
  ])("preserves document-approved renderer sources for %s documents", async (_, html) => {
    const { document } = await createHtmlDocument(html, "scripts");
    const response = await capture(document.entryUrl);
    const policy = String(response.headers["content-security-policy"]);
    const scripts = policy
      .split(";")
      .find((directive) => directive.trim().startsWith("script-src "));
    expect(scripts?.split(/\s+/)).toContain("'self'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("sandbox allow-scripts");
    expect(response.text).toBe(html);
  });

  it("serves sandbox-marked HTML with the stable CSP header and no mutation", async () => {
    const html = "<html><body>widget</body></html>";
    const { document } = await createHtmlDocument(html, "scripts");

    const response = await capture(document.entryUrl);
    expect(response).toMatchObject({ handled: true, statusCode: 200, text: html });
    expect(response.headers).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    const csp = String(response.headers["content-security-policy"]);
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("connect-src 'none'");
  });

  it("omits the sandbox response header for unmarked documents", async () => {
    const { document } = await createHtmlDocument("<html><body>plain</body></html>");

    const response = await capture(document.entryUrl);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });

  it("serves Content-Length on HEAD responses", async () => {
    const html = "<html><body>widget</body></html>";
    const { document } = await createHtmlDocument(html, "scripts");
    const css = "body { color: red; }";
    const file = (name: string) => path.join(resolveCanvasDocumentsDir(stateDir), "widget-1", name);
    await writeFile(file("style.css"), css, "utf8");

    const { get: getHtml, head: headHtml } = await expectHead(document.entryUrl);
    expect(headHtml.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headHtml.headers["content-security-policy"]).toBe(
      getHtml.headers["content-security-policy"],
    );

    await expectHead(documentUrl("style.css"));

    // Invalid UTF-8 in a copied HTML file expands to U+FFFD when served, so the
    // header must be measured from the decoded representation, not raw bytes.
    const brokenBytes = Buffer.from([
      0x3c, 0x68, 0x31, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x68, 0x31, 0x3e,
    ]);
    await writeFile(file("broken.html"), brokenBytes);
    const { get: getBroken } = await expectHead(documentUrl("broken.html"));
    expect(getBroken.body.byteLength).toBeGreaterThan(brokenBytes.byteLength);
  });

  it("rejects unsupported methods and traversal paths", async () => {
    const methodResponse = await capture(documentUrl(), "POST");
    expect(methodResponse).toMatchObject({ statusCode: 405, text: "Method Not Allowed" });

    const traversalResponse = await capture(
      "/__openclaw__/canvas/documents/../widget-1/index.html",
    );
    expect(traversalResponse.handled).toBe(false);

    const missingResponse = await capture(documentUrl());
    expect(missingResponse).toMatchObject({ statusCode: 404, text: "not found" });
  });
});
