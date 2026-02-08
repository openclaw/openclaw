import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleControlUiHttpRequest } from "./control-ui.js";

const makeResponse = (): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} => {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, setHeader, end };
};

describe("handleControlUiHttpRequest", () => {
  it("returns 404 for missing static asset paths instead of SPA fallback", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      // Create only index.html and a root-level favicon — no webchat/ subdir
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      await fs.writeFile(path.join(tmp, "favicon.svg"), "<svg/>");

      // Request /webchat/favicon.svg — file does NOT exist at that relative path
      const { res } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/webchat/favicon.svg", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      // Should be 404, NOT the SPA index.html fallback
      expect(res.statusCode).toBe(404);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("still serves SPA fallback for extensionless paths", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      // Request /webchat/chat — no file extension, should get SPA fallback
      const { res } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/webchat/chat", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      // SPA fallback should serve index.html with 200
      expect(res.statusCode).toBe(200);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("HEAD returns 404 for missing static assets consistent with GET", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      const { res } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/webchat/favicon.svg", method: "HEAD" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("serves SPA fallback for dotted path segments that are not static assets", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      // Dotted SPA routes like /webchat/user/jane.doe or /webchat/v2.0
      // should NOT 404 — only known static asset extensions should 404
      for (const route of ["/webchat/user/jane.doe", "/webchat/v2.0", "/settings/v1.2"]) {
        const { res } = makeResponse();
        const handled = handleControlUiHttpRequest(
          { url: route, method: "GET" } as IncomingMessage,
          res,
          { root: { kind: "resolved", path: tmp } },
        );
        expect(handled).toBe(true);
        expect(res.statusCode, `expected 200 for ${route}`).toBe(200);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("serves SPA fallback for .html paths that do not exist on disk", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      // /webchat/foo.html — .html should NOT be treated as a static-only
      // extension; client-side routers may use .html-suffixed routes
      const { res } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/webchat/foo.html", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("sets anti-clickjacking headers for Control UI responses", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      const { res, setHeader } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/", method: "GET" } as IncomingMessage,
        res,
        {
          root: { kind: "resolved", path: tmp },
        },
      );
      expect(handled).toBe(true);
      expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
      expect(setHeader).toHaveBeenCalledWith("Content-Security-Policy", "frame-ancestors 'none'");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
