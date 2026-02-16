import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

// Mock child_process.spawn so we don't actually start processes.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

describe("server-web-app", () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    existsSyncSpy = vi.spyOn(fs, "existsSync");
    delete process.env.OPENCLAW_SKIP_WEB_APP;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── resolveStandaloneServerJs ──────────────────────────────────────────

  describe("resolveStandaloneServerJs", () => {
    it("returns the correct monorepo-nested path for standalone server.js", async () => {
      const { resolveStandaloneServerJs } = await import("./server-web-app.js");
      const webAppDir = "/pkg/apps/web";
      expect(resolveStandaloneServerJs(webAppDir)).toBe(
        path.join("/pkg/apps/web/.next/standalone/apps/web/server.js"),
      );
    });
  });

  // ── hasStandaloneBuild ──────────────────────────────────────────────────

  describe("hasStandaloneBuild", () => {
    it("returns true when standalone server.js exists", async () => {
      const { hasStandaloneBuild, resolveStandaloneServerJs } = await import("./server-web-app.js");
      const webAppDir = "/pkg/apps/web";
      existsSyncSpy.mockImplementation((p) => {
        return String(p) === resolveStandaloneServerJs(webAppDir);
      });
      expect(hasStandaloneBuild(webAppDir)).toBe(true);
    });

    it("returns false when standalone server.js is missing", async () => {
      const { hasStandaloneBuild } = await import("./server-web-app.js");
      existsSyncSpy.mockReturnValue(false);
      expect(hasStandaloneBuild("/pkg/apps/web")).toBe(false);
    });
  });

  // ── hasLegacyNextBuild ──────────────────────────────────────────────────

  describe("hasLegacyNextBuild", () => {
    it("returns true when .next/BUILD_ID exists", async () => {
      const { hasLegacyNextBuild } = await import("./server-web-app.js");
      existsSyncSpy.mockImplementation((p) => {
        return String(p).endsWith(path.join(".next", "BUILD_ID"));
      });
      expect(hasLegacyNextBuild("/pkg/apps/web")).toBe(true);
    });

    it("returns false when .next/BUILD_ID is missing", async () => {
      const { hasLegacyNextBuild } = await import("./server-web-app.js");
      existsSyncSpy.mockReturnValue(false);
      expect(hasLegacyNextBuild("/pkg/apps/web")).toBe(false);
    });
  });

  // ── isInWorkspace ──────────────────────────────────────────────────────

  describe("isInWorkspace", () => {
    it("returns true when pnpm-workspace.yaml exists at root", async () => {
      const { isInWorkspace } = await import("./server-web-app.js");
      existsSyncSpy.mockImplementation((p) => {
        return String(p).endsWith("pnpm-workspace.yaml");
      });
      expect(isInWorkspace("/proj/apps/web")).toBe(true);
    });

    it("returns false when pnpm-workspace.yaml is missing (global install)", async () => {
      const { isInWorkspace } = await import("./server-web-app.js");
      existsSyncSpy.mockReturnValue(false);
      expect(isInWorkspace("/usr/lib/node_modules/ironclaw/apps/web")).toBe(false);
    });
  });

  // ── ensureWebAppBuilt ──────────────────────────────────────────────────

  describe("ensureWebAppBuilt", () => {
    const makeRuntime = (): RuntimeEnv => ({
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as unknown as (code?: number) => never,
    });

    it("returns ok when OPENCLAW_SKIP_WEB_APP is set", async () => {
      process.env.OPENCLAW_SKIP_WEB_APP = "1";
      const { ensureWebAppBuilt } = await import("./server-web-app.js");
      const result = await ensureWebAppBuilt(makeRuntime());
      expect(result).toEqual({ ok: true, built: false });
    });

    it("returns ok when web app is explicitly disabled", async () => {
      const { ensureWebAppBuilt } = await import("./server-web-app.js");
      const result = await ensureWebAppBuilt(makeRuntime(), {
        webAppConfig: { enabled: false },
      });
      expect(result).toEqual({ ok: true, built: false });
    });

    it("returns ok when dev mode is enabled (no pre-build needed)", async () => {
      const { ensureWebAppBuilt } = await import("./server-web-app.js");
      const result = await ensureWebAppBuilt(makeRuntime(), {
        webAppConfig: { dev: true },
      });
      expect(result).toEqual({ ok: true, built: false });
    });

    it("returns ok when apps/web directory is not found (global install without web)", async () => {
      const { ensureWebAppBuilt } = await import("./server-web-app.js");
      existsSyncSpy.mockReturnValue(false);
      const result = await ensureWebAppBuilt(makeRuntime());
      expect(result).toEqual({ ok: true, built: false });
    });

    it("returns ok when standalone build exists", async () => {
      const { ensureWebAppBuilt } = await import("./server-web-app.js");
      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        if (s.includes(path.join(".next", "standalone", "apps", "web", "server.js"))) {
          return true;
        }
        return false;
      });
      const result = await ensureWebAppBuilt(makeRuntime());
      expect(result).toEqual({ ok: true, built: false });
    });

    it("returns ok when legacy .next/BUILD_ID exists (dev workspace)", async () => {
      const { ensureWebAppBuilt } = await import("./server-web-app.js");
      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        if (s.endsWith(path.join(".next", "BUILD_ID"))) {
          return true;
        }
        return false;
      });
      const result = await ensureWebAppBuilt(makeRuntime());
      expect(result).toEqual({ ok: true, built: false });
    });

    it("returns error for global install when no build found", async () => {
      const { ensureWebAppBuilt } = await import("./server-web-app.js");
      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        // Only the package.json exists — no build, no workspace.
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        return false;
      });
      const result = await ensureWebAppBuilt(makeRuntime());
      expect(result.ok).toBe(false);
      expect(result.built).toBe(false);
      expect(result.message).toContain("standalone build not found");
    });
  });

  // ── startWebAppIfEnabled ───────────────────────────────────────────────

  describe("startWebAppIfEnabled", () => {
    const makeLog = () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    function mockChildProcess() {
      const events: Record<string, ((...args: unknown[]) => void)[]> = {};
      const onceEvents: Record<string, ((...args: unknown[]) => void)[]> = {};
      const child = {
        exitCode: null as number | null,
        killed: false,
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          events[event] = events[event] || [];
          events[event].push(cb);
        }),
        once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          onceEvents[event] = onceEvents[event] || [];
          onceEvents[event].push(cb);
        }),
        removeListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const arr = onceEvents[event];
          if (arr) {
            const idx = arr.indexOf(cb);
            if (idx >= 0) {
              arr.splice(idx, 1);
            }
          }
        }),
        kill: vi.fn(),
        _emit: (event: string, ...args: unknown[]) => {
          for (const cb of events[event] || []) {
            cb(...args);
          }
          // Fire and remove once listeners.
          const once = onceEvents[event] || [];
          onceEvents[event] = [];
          for (const cb of once) {
            cb(...args);
          }
        },
      };
      vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
      return child;
    }

    it("returns null when OPENCLAW_SKIP_WEB_APP is set", async () => {
      process.env.OPENCLAW_SKIP_WEB_APP = "1";
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      const result = await startWebAppIfEnabled({ enabled: true }, makeLog());
      expect(result).toBeNull();
    });

    it("returns null when config is undefined", async () => {
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      const result = await startWebAppIfEnabled(undefined, makeLog());
      expect(result).toBeNull();
    });

    it("returns null when web app is disabled", async () => {
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      const result = await startWebAppIfEnabled({ enabled: false }, makeLog());
      expect(result).toBeNull();
    });

    it("returns null when apps/web directory not found", async () => {
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      existsSyncSpy.mockReturnValue(false);
      const log = makeLog();
      const result = await startWebAppIfEnabled({ enabled: true }, log);
      expect(result).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("apps/web directory not found"),
      );
    });

    it("starts standalone server.js in production mode", async () => {
      vi.useFakeTimers();
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      mockChildProcess();

      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        if (s.includes(path.join(".next", "standalone", "apps", "web", "server.js"))) {
          return true;
        }
        return false;
      });

      const log = makeLog();
      const resultPromise = startWebAppIfEnabled({ enabled: true, port: 4000 }, log);
      await vi.advanceTimersByTimeAsync(3_500);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      expect(result!.port).toBe(4000);
      expect(spawn).toHaveBeenCalledWith(
        "node",
        [expect.stringContaining("server.js")],
        expect.objectContaining({
          stdio: "pipe",
          env: expect.objectContaining({ PORT: "4000", HOSTNAME: "0.0.0.0" }),
        }),
      );
      // Should NOT try to install deps or build.
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("standalone"));
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("installing"));
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("building"));
      vi.useRealTimers();
    });

    it("falls back to legacy next start when BUILD_ID exists but no standalone", async () => {
      vi.useFakeTimers();
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      mockChildProcess();

      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        // Legacy BUILD_ID exists.
        if (s.endsWith(path.join(".next", "BUILD_ID"))) {
          return true;
        }
        // next is installed (for ensureDevDepsInstalled check).
        if (s.endsWith(path.join("node_modules", "next", "package.json"))) {
          return true;
        }
        return false;
      });

      const log = makeLog();
      // Use an explicit high port to avoid the real web app on default port.
      const resultPromise = startWebAppIfEnabled({ enabled: true, port: 49100 }, log);
      await vi.advanceTimersByTimeAsync(3_500);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to legacy next start"),
      );
      vi.useRealTimers();
    });

    it("returns null with error for global install when no build exists", async () => {
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      mockChildProcess();

      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        // Only package.json exists — no builds, no workspace.
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        return false;
      });

      const log = makeLog();
      // Use an explicit high port to avoid the real web app on default port.
      const result = await startWebAppIfEnabled({ enabled: true, port: 49101 }, log);

      expect(result).toBeNull();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("standalone build not found"));
    });

    it("uses default port when not specified", async () => {
      vi.useFakeTimers();
      const { startWebAppIfEnabled, DEFAULT_WEB_APP_PORT } = await import("./server-web-app.js");
      mockChildProcess();

      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        if (s.includes(path.join(".next", "standalone", "apps", "web", "server.js"))) {
          return true;
        }
        return false;
      });

      const resultPromise = startWebAppIfEnabled({ enabled: true }, makeLog());
      await vi.advanceTimersByTimeAsync(3_500);
      const result = await resultPromise;
      // Port detection picks the default port if free, or the next available.
      expect(result!.port).toBeGreaterThanOrEqual(DEFAULT_WEB_APP_PORT);
      vi.useRealTimers();
    });

    it("stop() sends SIGTERM then resolves on exit", async () => {
      vi.useFakeTimers();
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      const child = mockChildProcess();

      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        if (s.includes(path.join(".next", "standalone", "apps", "web", "server.js"))) {
          return true;
        }
        return false;
      });

      // Use an explicit high port to avoid the real web app on default port.
      const resultPromise = startWebAppIfEnabled({ enabled: true, port: 49102 }, makeLog());
      await vi.advanceTimersByTimeAsync(3_500);
      const result = await resultPromise;
      expect(result).not.toBeNull();

      // Simulate: process hasn't exited yet.
      const stopPromise = result!.stop();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // Simulate the exit event.
      child._emit("exit", 0, null);
      await stopPromise;
      vi.useRealTimers();
    });

    it("returns null and logs error when child process crashes on startup", async () => {
      vi.useFakeTimers();
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      const child = mockChildProcess();

      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        if (s.includes(path.join(".next", "standalone", "apps", "web", "server.js"))) {
          return true;
        }
        return false;
      });

      const log = makeLog();
      // Use an explicit high port to avoid the real web app on default port.
      const resultPromise = startWebAppIfEnabled({ enabled: true, port: 49103 }, log);

      // Simulate the child crashing immediately (e.g. Cannot find module 'next').
      child.exitCode = 1;
      child._emit("exit", 1, null);

      const result = await resultPromise;

      expect(result).toBeNull();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("web app failed to start"));
      vi.useRealTimers();
    });

    it("reuses existing web app when preferred port already has Next.js running", async () => {
      const { startWebAppIfEnabled } = await import("./server-web-app.js");

      // Clear accumulated spawn call history from previous tests (the
      // module-level vi.mock isn't reset by vi.restoreAllMocks).
      vi.mocked(spawn).mockClear();

      // resolveWebAppDir() needs to find a valid directory before reaching
      // the port check, so mock existsSync for the package.json check.
      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        return false;
      });

      // Start a real HTTP server that mimics a Next.js app on a high port.
      const testPort = 13_199;
      const httpServer = http.createServer((_, res) => {
        res.setHeader("x-powered-by", "Next.js");
        res.writeHead(200);
        res.end("ok");
      });
      await new Promise<void>((resolve) => httpServer.listen(testPort, resolve));

      try {
        const log = makeLog();
        const result = await startWebAppIfEnabled({ enabled: true, port: testPort }, log);

        expect(result).not.toBeNull();
        expect(result!.port).toBe(testPort);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already running"));
        // No child process should be spawned for the reuse path.
        expect(spawn).not.toHaveBeenCalled();

        // stop() should be a no-op (we didn't spawn this process).
        await expect(result!.stop()).resolves.toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    });

    it("finds alternative port when preferred port is occupied by non-Next.js app", async () => {
      // Real timers: multiple async I/O steps (isPortFree + probeForWebApp)
      // run before the timer-based waitForStartupOrCrash, so fake timers
      // can't advance the clock early enough.
      const { startWebAppIfEnabled } = await import("./server-web-app.js");
      mockChildProcess();

      existsSyncSpy.mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith(path.join("apps", "web", "package.json"))) {
          return true;
        }
        if (s.includes(path.join(".next", "standalone", "apps", "web", "server.js"))) {
          return true;
        }
        return false;
      });

      // Start a plain HTTP server (no x-powered-by: Next.js) to simulate
      // another app occupying the port.
      const testPort = 13_200;
      const httpServer = http.createServer((_, res) => {
        res.writeHead(200);
        res.end("not next");
      });
      await new Promise<void>((resolve) => httpServer.listen(testPort, resolve));

      try {
        const log = makeLog();
        const result = await startWebAppIfEnabled({ enabled: true, port: testPort }, log);

        expect(result).not.toBeNull();
        expect(result!.port).not.toBe(testPort);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("is busy"));
      } finally {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    }, 15_000);
  });
});
