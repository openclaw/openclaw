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
  it("returns 404 for static asset paths that do not exist instead of SPA fallback", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      // favicon.svg does NOT exist under webchat/
      const { res, end } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/webchat/favicon.svg", method: "GET" } as IncomingMessage,
        res,
        {
          root: { kind: "resolved", path: tmp },
        },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("still serves SPA fallback for extensionless paths", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      const { res, end } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/webchat/chat", method: "GET" } as IncomingMessage,
        res,
        {
          root: { kind: "resolved", path: tmp },
        },
      );
      expect(handled).toBe(true);
      // Should serve index.html (SPA fallback), not 404
      expect(res.statusCode).not.toBe(404);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("serves existing static assets with correct content type", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      await fs.writeFile(path.join(tmp, "favicon.svg"), "<svg></svg>\n");
      const { res, setHeader } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/favicon.svg", method: "GET" } as IncomingMessage,
        res,
        {
          root: { kind: "resolved", path: tmp },
        },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).not.toBe(404);
      expect(setHeader).toHaveBeenCalledWith("Content-Type", "image/svg+xml");
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
