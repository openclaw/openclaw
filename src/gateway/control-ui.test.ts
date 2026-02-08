import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildControlUiAvatarUrl,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";
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

// ---------------------------------------------------------------------------
// handleControlUiHttpRequest – SPA fallback vs /api/* routes
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
} {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: "",
    set statusCode(v: number) {
      this._status = v;
    },
    get statusCode() {
      return this._status;
    },
    setHeader(k: string, v: string) {
      this._headers[k.toLowerCase()] = v;
    },
    end(body?: string | Buffer) {
      if (body != null) this._body = typeof body === "string" ? body : body.toString("utf8");
    },
  } as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
  };
  return res;
}

describe("handleControlUiHttpRequest – /api/ exclusion", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cui-test-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html><body>SPA</body></html>", "utf8");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const rootState = () => ({ kind: "resolved" as const, path: tmpDir });

  it("serves SPA fallback for normal unknown routes", () => {
    const req = mockReq("GET", "/some/page");
    const res = mockRes();
    const handled = handleControlUiHttpRequest(req, res, { root: rootState() });
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._headers["content-type"]).toContain("text/html");
    expect(res._body).toContain("SPA");
  });

  it("returns JSON 404 for /api/ routes instead of SPA fallback", () => {
    const req = mockReq("GET", "/api/some-endpoint");
    const res = mockRes();
    const handled = handleControlUiHttpRequest(req, res, { root: rootState() });
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
    expect(res._headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res._body)).toEqual({ error: "Not found" });
  });

  it("returns JSON 404 for /api (no trailing slash)", () => {
    const req = mockReq("GET", "/api");
    const res = mockRes();
    const handled = handleControlUiHttpRequest(req, res, { root: rootState() });
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: "Not found" });
  });

  it("returns JSON 404 for /api/ routes under a basePath", () => {
    const req = mockReq("GET", "/ui/api/foo");
    const res = mockRes();
    const handled = handleControlUiHttpRequest(req, res, {
      basePath: "/ui",
      root: rootState(),
    });
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
    expect(res._headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res._body)).toEqual({ error: "Not found" });
  });
});
