import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearInternalHooks,
  getRegisteredEventKeys,
  triggerInternalHook,
  createInternalHookEvent,
} from "./internal-hooks.js";
import { loadInternalHooks } from "./loader.js";

describe("loader", () => {
  let tmpDir: string;
  let hooksDir: string;
  let originalBundledDir: string | undefined;

  beforeEach(async () => {
    clearInternalHooks();
    // Create a temp directory for test modules
    tmpDir = path.join(os.tmpdir(), `openclaw-test-${Date.now()}`);
    // Handlers must be within the workspace hooks directory to pass security validation
    hooksDir = path.join(tmpDir, "hooks");
    await fs.mkdir(hooksDir, { recursive: true });

    // Disable bundled hooks during tests by setting env var to non-existent directory
    originalBundledDir = process.env.OPENCLAW_BUNDLED_HOOKS_DIR;
    process.env.OPENCLAW_BUNDLED_HOOKS_DIR = "/nonexistent/bundled/hooks";
  });

  afterEach(async () => {
    clearInternalHooks();
    // Restore original env var
    if (originalBundledDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_HOOKS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_HOOKS_DIR = originalBundledDir;
    }
    // Clean up temp directory
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("loadInternalHooks", () => {
    it("should return 0 when hooks are not enabled", async () => {
      const cfg: OpenClawConfig = {
        hooks: {
          internal: {
            enabled: false,
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
    });

    it("should return 0 when hooks config is missing", async () => {
      const cfg: OpenClawConfig = {};
      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
    });

    it("should load a handler from a module", async () => {
      const handlerPath = path.join(hooksDir, "test-handler.js");
      const handlerCode = `
        export default async function(event) {
          // Test handler
        }
      `;
      await fs.writeFile(handlerPath, handlerCode, "utf-8");

      const cfg: OpenClawConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: handlerPath,
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
    });

    it("should load multiple handlers", async () => {
      const handler1Path = path.join(hooksDir, "handler1.js");
      const handler2Path = path.join(hooksDir, "handler2.js");

      await fs.writeFile(handler1Path, "export default async function() {}", "utf-8");
      await fs.writeFile(handler2Path, "export default async function() {}", "utf-8");

      const cfg: OpenClawConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              { event: "command:new", module: handler1Path },
              { event: "command:stop", module: handler2Path },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(2);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
      expect(keys).toContain("command:stop");
    });

    it("should support named exports", async () => {
      const handlerPath = path.join(hooksDir, "named-export.js");
      const handlerCode = `
        export const myHandler = async function(event) {
          // Named export handler
        }
      `;
      await fs.writeFile(handlerPath, handlerCode, "utf-8");

      const cfg: OpenClawConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: handlerPath,
                export: "myHandler",
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);
    });

    it("should handle module loading errors gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const cfg: OpenClawConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: "/nonexistent/path/handler.js",
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
      expect(consoleError).toHaveBeenCalled();

      consoleError.mockRestore();
    });

    it("should handle non-function exports", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const handlerPath = path.join(hooksDir, "bad-export.js");
      await fs.writeFile(handlerPath, 'export default "not a function";', "utf-8");

      const cfg: OpenClawConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: handlerPath,
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("is not a function"));

      consoleError.mockRestore();
    });

    it("should reject handlers from outside allowed directories", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      // Create a handler outside the workspace hooks directory
      const outsidePath = path.join(tmpDir, "outside-handler.js");
      await fs.writeFile(outsidePath, "export default async function() {}", "utf-8");

      const cfg: OpenClawConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: outsidePath,
              },
            ],
          },
        },
      };

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);

      consoleError.mockRestore();
    });

    it("should actually call the loaded handler", async () => {
      const handlerPath = path.join(hooksDir, "callable-handler.js");
      const handlerCode = `
        let callCount = 0;
        export default async function(event) {
          callCount++;
        }
        export function getCallCount() {
          return callCount;
        }
      `;
      await fs.writeFile(handlerPath, handlerCode, "utf-8");

      const cfg: OpenClawConfig = {
        hooks: {
          internal: {
            enabled: true,
            handlers: [
              {
                event: "command:new",
                module: handlerPath,
              },
            ],
          },
        },
      };

      await loadInternalHooks(cfg, tmpDir);

      // Trigger the hook
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(getRegisteredEventKeys()).toContain("command:new");
    });
  });
});
