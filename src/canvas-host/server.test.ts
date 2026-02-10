import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { defaultRuntime } from "../runtime.js";
import {
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  injectCanvasLiveReload,
  resetA2uiRootCacheForTests,
} from "./a2ui.js";
import { createCanvasHostHandler, startCanvasHost } from "./server.js";

describe("canvas host", () => {
  it("injects live reload script", () => {
    const out = injectCanvasLiveReload("<html><body>Hello</body></html>");
    expect(out).toContain(CANVAS_WS_PATH);
    expect(out).toContain("location.reload");
    expect(out).toContain("openclawCanvasA2UIAction");
    expect(out).toContain("openclawSendUserAction");
  });

  it("creates a default index.html when missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-"));

    const server = await startCanvasHost({
      runtime: defaultRuntime,
      rootDir: dir,
      port: 0,
      listenHost: "127.0.0.1",
      allowInTests: true,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}${CANVAS_HOST_PATH}/`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("Interactive test page");
      expect(html).toContain("openclawSendUserAction");
      expect(html).toContain(CANVAS_WS_PATH);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips live reload injection when disabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-"));
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>no-reload</body></html>", "utf8");

    const server = await startCanvasHost({
      runtime: defaultRuntime,
      rootDir: dir,
      port: 0,
      listenHost: "127.0.0.1",
      allowInTests: true,
      liveReload: false,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}${CANVAS_HOST_PATH}/`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("no-reload");
      expect(html).not.toContain(CANVAS_WS_PATH);

      const wsRes = await fetch(`http://127.0.0.1:${server.port}${CANVAS_WS_PATH}`);
      expect(wsRes.status).toBe(404);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("serves canvas content from the mounted base path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-"));
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>v1</body></html>", "utf8");

    const handler = await createCanvasHostHandler({
      runtime: defaultRuntime,
      rootDir: dir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: true,
    });

    const server = createServer((req, res) => {
      void (async () => {
        if (await handler.handleHttpRequest(req, res)) {
          return;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
      })();
    });
    server.on("upgrade", (req, socket, head) => {
      if (handler.handleUpgrade(req, socket, head)) {
        return;
      }
      socket.destroy();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}${CANVAS_HOST_PATH}/`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("v1");
      expect(html).toContain(CANVAS_WS_PATH);

      const miss = await fetch(`http://127.0.0.1:${port}/`);
      expect(miss.status).toBe(404);
    } finally {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reuses a handler without closing it twice", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-"));
    await fs.writeFile(path.join(dir, "index.html"), "<html><body>v1</body></html>", "utf8");

    const handler = await createCanvasHostHandler({
      runtime: defaultRuntime,
      rootDir: dir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: true,
    });
    const originalClose = handler.close;
    const closeSpy = vi.fn(async () => originalClose());
    handler.close = closeSpy;

    const server = await startCanvasHost({
      runtime: defaultRuntime,
      handler,
      ownsHandler: false,
      port: 0,
      listenHost: "127.0.0.1",
      allowInTests: true,
    });

    try {
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.close();
      expect(closeSpy).not.toHaveBeenCalled();
      await originalClose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("serves HTML with injection and broadcasts reload on file changes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-"));
    const index = path.join(dir, "index.html");
    await fs.writeFile(index, "<html><body>v1</body></html>", "utf8");

    const server = await startCanvasHost({
      runtime: defaultRuntime,
      rootDir: dir,
      port: 0,
      listenHost: "127.0.0.1",
      allowInTests: true,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}${CANVAS_HOST_PATH}/`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("v1");
      expect(html).toContain(CANVAS_WS_PATH);

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}${CANVAS_WS_PATH}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
        ws.on("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const msg = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("reload timeout")), 10_000);
        ws.on("message", (data) => {
          clearTimeout(timer);
          resolve(rawDataToString(data));
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.writeFile(index, "<html><body>v2</body></html>", "utf8");
      expect(await msg).toBe("reload");
      ws.close();
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("serves the gateway-hosted A2UI scaffold", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-"));
    const a2uiRoot = path.resolve(process.cwd(), "src/canvas-host/a2ui");
    const bundlePath = path.join(a2uiRoot, "a2ui.bundle.js");
    let createdBundle = false;

    try {
      await fs.stat(bundlePath);
    } catch {
      await fs.writeFile(bundlePath, "window.openclawA2UI = {};", "utf8");
      createdBundle = true;
    }

    const server = await startCanvasHost({
      runtime: defaultRuntime,
      rootDir: dir,
      port: 0,
      listenHost: "127.0.0.1",
      allowInTests: true,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/__openclaw__/a2ui/`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("openclaw-a2ui-host");
      expect(html).toContain("openclawCanvasA2UIAction");

      const bundleRes = await fetch(
        `http://127.0.0.1:${server.port}/__openclaw__/a2ui/a2ui.bundle.js`,
      );
      const js = await bundleRes.text();
      expect(bundleRes.status).toBe(200);
      expect(js).toContain("openclawA2UI");
    } finally {
      await server.close();
      if (createdBundle) {
        await fs.rm(bundlePath, { force: true });
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retries A2UI lookup after an initial miss and resolves bundled dist assets via argv[1]", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2ui-argv-"));
    const canvasDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-"));
    const fakeDistDir = path.join(dir, "dist");
    const fakeA2uiDir = path.join(fakeDistDir, "canvas-host", "a2ui");
    const prevArgv1 = process.argv[1];
    const prevCwd = process.cwd();

    resetA2uiRootCacheForTests();
    process.argv[1] = path.join(fakeDistDir, "entry.js");
    process.chdir(dir);

    const server = await startCanvasHost({
      runtime: defaultRuntime,
      rootDir: canvasDir,
      port: 0,
      listenHost: "127.0.0.1",
      allowInTests: true,
    });

    try {
      const missRes = await fetch(`http://127.0.0.1:${server.port}/__openclaw__/a2ui/`);
      expect(missRes.status).toBe(503);

      await fs.mkdir(fakeA2uiDir, { recursive: true });
      await fs.writeFile(
        path.join(fakeA2uiDir, "index.html"),
        "<html><body>argv-a2ui</body></html>",
        "utf8",
      );
      await fs.writeFile(path.join(fakeA2uiDir, "a2ui.bundle.js"), "window.argvA2ui = true;", "utf8");

      const hitRes = await fetch(`http://127.0.0.1:${server.port}/__openclaw__/a2ui/`);
      expect(hitRes.status).toBe(200);
      expect(await hitRes.text()).toContain("argv-a2ui");

      const bundleRes = await fetch(
        `http://127.0.0.1:${server.port}/__openclaw__/a2ui/a2ui.bundle.js`,
      );
      expect(bundleRes.status).toBe(200);
      expect(await bundleRes.text()).toContain("argvA2ui");
    } finally {
      await server.close();
      process.argv[1] = prevArgv1;
      process.chdir(prevCwd);
      resetA2uiRootCacheForTests();
      await fs.rm(canvasDir, { recursive: true, force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
