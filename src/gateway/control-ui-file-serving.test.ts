import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleWorkspaceFileRequest } from "./control-ui-file-serving.js";

function createMockReq(url: string, method = "GET") {
  return { url, method, headers: {} } as import("node:http").IncomingMessage;
}

function createMockRes() {
  const headers = new Map<string, string | number>();
  let statusCode = 200;
  let body: Buffer | string | undefined;
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    setHeader(name: string, value: string | number) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(data?: Buffer | string) {
      body = data;
    },
  } as unknown as import("node:http").ServerResponse;
  return { res, getStatus: () => statusCode, getBody: () => body, getHeaders: () => headers };
}

describe("handleWorkspaceFileRequest", () => {
  let tmpDir: string;
  let testImagePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-file-test-"));
    testImagePath = path.join(tmpDir, "test.png");
    // Create a minimal PNG file (1x1 pixel)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(testImagePath, pngHeader);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves an image file with correct content type", () => {
    const encoded = Buffer.from(testImagePath).toString("base64url");
    const req = createMockReq(`/__file__/${encoded}`);
    const { res, getStatus, getHeaders } = createMockRes();

    const handled = handleWorkspaceFileRequest(req, res);
    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    expect(getHeaders().get("content-type")).toBe("image/png");
  });

  it("returns false for non-matching paths", () => {
    const req = createMockReq("/some/other/path");
    const { res } = createMockRes();

    const handled = handleWorkspaceFileRequest(req, res);
    expect(handled).toBe(false);
  });

  it("returns 404 for non-existent files", () => {
    const encoded = Buffer.from("/nonexistent/file.png").toString("base64url");
    const req = createMockReq(`/__file__/${encoded}`);
    const { res, getStatus } = createMockRes();

    const handled = handleWorkspaceFileRequest(req, res);
    expect(handled).toBe(true);
    expect(getStatus()).toBe(404);
  });

  it("returns 403 for disallowed file types", () => {
    const jsFile = path.join(tmpDir, "script.js");
    fs.writeFileSync(jsFile, "console.log('hello')");
    const encoded = Buffer.from(jsFile).toString("base64url");
    const req = createMockReq(`/__file__/${encoded}`);
    const { res, getStatus } = createMockRes();

    const handled = handleWorkspaceFileRequest(req, res);
    expect(handled).toBe(true);
    expect(getStatus()).toBe(403);
  });

  it("handles basePath correctly", () => {
    const encoded = Buffer.from(testImagePath).toString("base64url");
    const req = createMockReq(`/ui/__file__/${encoded}`);
    const { res, getStatus } = createMockRes();

    const handled = handleWorkspaceFileRequest(req, res, { basePath: "/ui" });
    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
  });

  it("returns 404 for null bytes in path", () => {
    const encoded = Buffer.from("/tmp/test\0.png").toString("base64url");
    const req = createMockReq(`/__file__/${encoded}`);
    const { res, getStatus } = createMockRes();

    const handled = handleWorkspaceFileRequest(req, res);
    expect(handled).toBe(true);
    expect(getStatus()).toBe(404);
  });

  it("returns false for POST requests", () => {
    const encoded = Buffer.from(testImagePath).toString("base64url");
    const req = createMockReq(`/__file__/${encoded}`, "POST");
    const { res } = createMockRes();

    const handled = handleWorkspaceFileRequest(req, res);
    expect(handled).toBe(false);
  });
});
