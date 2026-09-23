// Core Canvas document HTTP response coverage.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvasDocument, resolveCanvasDocumentsDir } from "./documents.js";
import { handleCanvasDocumentHttpRequest } from "./serve.runtime.js";
import { buildWidgetDocument } from "./wrap.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStateDir(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-canvas-serve-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
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
    const stateDir = await createStateDir();
    const document = await createCanvasDocument(
      { kind: "html_bundle", entrypoint: { type: "html", value: html }, cspSandbox: "scripts" },
      { stateDir },
    );
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
    const stateDir = await createStateDir();
    const html = "<html><body>widget</body></html>";
    const document = await createCanvasDocument(
      {
        id: "widget-1",
        kind: "html_bundle",
        entrypoint: { type: "html", value: html },
        cspSandbox: "scripts",
      },
      { stateDir },
    );

    const response = await capture(document.entryUrl);
    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    const csp = String(response.headers["content-security-policy"]);
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("connect-src 'none'");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.text).toBe(html);
  });

  it("omits the sandbox response header for unmarked documents", async () => {
    const stateDir = await createStateDir();
    const document = await createCanvasDocument(
      {
        id: "plain-1",
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<html><body>plain</body></html>" },
      },
      { stateDir },
    );

    const response = await capture(document.entryUrl);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });

  it("serves Content-Length on HEAD responses", async () => {
    const stateDir = await createStateDir();
    const html = "<html><body>widget</body></html>";
    const document = await createCanvasDocument(
      {
        id: "widget-1",
        kind: "html_bundle",
        entrypoint: { type: "html", value: html },
        cspSandbox: "scripts",
      },
      { stateDir },
    );
    const css = "body { color: red; }";
    await writeFile(
      path.join(resolveCanvasDocumentsDir(stateDir), "widget-1", "style.css"),
      css,
      "utf8",
    );
    const cssUrl = document.entryUrl.replace(/index\.html$/, "style.css");

    const getHtml = await capture(document.entryUrl);
    const headHtml = await capture(document.entryUrl, "HEAD");
    expect(headHtml.statusCode).toBe(200);
    expect(headHtml.headers["content-length"]).toBe(String(getHtml.body.byteLength));
    expect(headHtml.body.byteLength).toBe(0);
    expect(headHtml.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headHtml.headers["content-security-policy"]).toBe(
      getHtml.headers["content-security-policy"],
    );

    const getCss = await capture(cssUrl);
    const headCss = await capture(cssUrl, "HEAD");
    expect(getCss.statusCode).toBe(200);
    expect(headCss.statusCode).toBe(200);
    expect(headCss.headers["content-length"]).toBe(String(getCss.body.byteLength));
    expect(headCss.body.byteLength).toBe(0);

    // Invalid UTF-8 in a copied HTML file expands to U+FFFD when served, so the
    // header must be measured from the decoded representation, not raw bytes.
    const brokenBytes = Buffer.from([
      0x3c, 0x68, 0x31, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x68, 0x31, 0x3e,
    ]);
    await writeFile(
      path.join(resolveCanvasDocumentsDir(stateDir), "widget-1", "broken.html"),
      brokenBytes,
    );
    const brokenUrl = document.entryUrl.replace(/index\.html$/, "broken.html");
    const getBroken = await capture(brokenUrl);
    const headBroken = await capture(brokenUrl, "HEAD");
    expect(getBroken.statusCode).toBe(200);
    expect(getBroken.body.byteLength).toBeGreaterThan(brokenBytes.byteLength);
    expect(headBroken.headers["content-length"]).toBe(String(getBroken.body.byteLength));
    expect(headBroken.body.byteLength).toBe(0);
  });

  it("rejects unsupported methods and traversal paths", async () => {
    await createStateDir();
    const methodResponse = await capture(
      "/__openclaw__/canvas/documents/widget-1/index.html",
      "POST",
    );
    expect(methodResponse.statusCode).toBe(405);
    expect(methodResponse.text).toBe("Method Not Allowed");

    const traversalResponse = await capture(
      "/__openclaw__/canvas/documents/../widget-1/index.html",
    );
    expect(traversalResponse.handled).toBe(false);

    const missingResponse = await capture("/__openclaw__/canvas/documents/widget-1/index.html");
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.text).toBe("not found");
  });
});
