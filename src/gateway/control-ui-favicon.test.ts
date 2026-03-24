import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
// Test to reproduce issue #53172 - favicon.svg not served under basePath
import { describe, expect, it } from "vitest";
import { handleControlUiHttpRequest } from "./control-ui.js";

function makeMockHttpResponse() {
  const chunks: (Buffer | string)[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
    write: (chunk: Buffer | string) => chunks.push(chunk),
    end: (chunk?: Buffer | string) => {
      if (chunk) {
        chunks.push(chunk);
      }
    },
  } as unknown as ServerResponse;
  const end = () => {
    const result = chunks.map((c) => (typeof c === "string" ? c : c.toString())).join("");
    return result;
  };
  return { res, end, headers };
}

async function withControlUiRoot(fn: (tmp: string) => Promise<void>) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "openclaw-ui-root-"));
  try {
    await mkdir(path.join(tmp, "assets"), { recursive: true });
    await writeFile(path.join(tmp, "index.html"), "<html>ok</html>\n");
    await writeFile(path.join(tmp, "favicon.svg"), "<svg>ok</svg>\n");
    return await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

describe("favicon.svg under basePath (issue #53172)", () => {
  it("serves favicon.svg under basePath /openclaw", async () => {
    await withControlUiRoot(async (tmp) => {
      const { res, end } = makeMockHttpResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/openclaw/favicon.svg", method: "GET" } as IncomingMessage,
        res,
        {
          basePath: "/openclaw",
          root: { kind: "resolved", path: tmp },
        },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(end().toString()).toContain("<svg>");
    });
  });

  it("serves favicon.svg at root when no basePath", async () => {
    await withControlUiRoot(async (tmp) => {
      const { res, end } = makeMockHttpResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/favicon.svg", method: "GET" } as IncomingMessage,
        res,
        {
          basePath: "", // no basePath
          root: { kind: "resolved", path: tmp },
        },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(end().toString()).toContain("<svg>");
    });
  });

  it("returns 404 for /openclaw/favicon.svg when no basePath configured", async () => {
    await withControlUiRoot(async (tmp) => {
      const { res, end } = makeMockHttpResponse();
      const handled = handleControlUiHttpRequest(
        { url: "/openclaw/favicon.svg", method: "GET" } as IncomingMessage,
        res,
        {
          basePath: "", // no basePath - Control UI served at root
          root: { kind: "resolved", path: tmp },
        },
      );
      // When basePath is empty, the entire URL is treated as the file path
      // So /openclaw/favicon.svg would look for a file named that, which doesn't exist
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
      expect(end().toString()).toBe("Not Found");
    });
  });
});
