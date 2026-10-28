import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { startBuiltControlUiE2eServer } from "./control-ui-e2e.ts";

it("serves raw preview assets with immutable caching without caching documents or missing assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-ui-cache-"));
  let server: Awaited<ReturnType<typeof startBuiltControlUiE2eServer>> | undefined;
  try {
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>Cache fixture</title>");
    await writeFile(path.join(root, "assets", "entry-abcdefgh.js"), "export const ready = true;");
    // Production sidecars can be present, but this preview server never negotiates them.
    for (const [extension, body] of [
      ["gz", gzipSync("unused gzip sidecar")],
      ["br", brotliCompressSync("unused Brotli sidecar")],
    ] as const) {
      await writeFile(path.join(root, "assets", `entry-abcdefgh.js.${extension}`), body);
    }
    server = await startBuiltControlUiE2eServer(root);
    for (const pathname of ["/assets/entry-abcdefgh.js", "/chat/assets/entry-abcdefgh.js"]) {
      const response = await fetch(new URL(pathname, server.baseUrl), {
        headers: { "accept-encoding": "gzip, br" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe("export const ready = true;");
    }
    const document = await fetch(new URL("/", server.baseUrl));
    expect(document.status).toBe(200);
    expect(document.headers.get("cache-control") ?? "").not.toContain("immutable");
    await document.text();
    const missing = await fetch(new URL("/assets/missing-abcdefgh.js", server.baseUrl));
    expect(missing.headers.get("cache-control") ?? "").not.toContain("immutable");
    await missing.text();
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
