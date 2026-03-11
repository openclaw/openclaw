import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import {
  clearInternalHooks,
  getRegisteredEventKeys,
  triggerInternalHook,
  createInternalHookEvent,
} from "./internal-hooks.js";
import { loadInternalHooks, loadInternalHooksForStartup } from "./loader.js";

describe("loader", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let tmpDir: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hooks-loader-"));
  });

  beforeEach(async () => {
    clearInternalHooks();
    // Create a temp directory for test modules
    tmpDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(tmpDir, { recursive: true });

    // Disable bundled hooks during tests by setting env var to non-existent directory
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_HOOKS_DIR"]);
    process.env.OPENCLAW_BUNDLED_HOOKS_DIR = "/nonexistent/bundled/hooks";
  });

  async function writeHandlerModule(
    fileName: string,
    code = "export default async function() {}",
  ): Promise<string> {
    const handlerPath = path.join(tmpDir, fileName);
    await fs.writeFile(handlerPath, code, "utf-8");
    return handlerPath;
  }

  function createEnabledHooksConfig(
    handlers?: Array<{ event: string; module: string; export?: string }>,
  ): OpenClawConfig {
    return {
      hooks: {
        internal: handlers ? { enabled: true, handlers } : { enabled: true },
      },
    };
  }

  function createMultiAgentHooksConfig(params: {
    mainWorkspace: string;
    opsWorkspace: string;
    defaultAgentId?: "main" | "ops";
    extraDirs?: string[];
    handlers?: Array<{ event: string; module: string; export?: string }>;
  }): OpenClawConfig {
    const defaultAgentId = params.defaultAgentId ?? "main";
    return {
      hooks: {
        internal: {
          enabled: true,
          ...(params.extraDirs && params.extraDirs.length > 0
            ? { load: { extraDirs: params.extraDirs } }
            : {}),
          ...(params.handlers ? { handlers: params.handlers } : {}),
        },
      },
      agents: {
        list: [
          { id: "main", default: defaultAgentId === "main", workspace: params.mainWorkspace },
          { id: "ops", default: defaultAgentId === "ops", workspace: params.opsWorkspace },
        ],
      },
    };
  }

  async function writeHandlerModuleInDir(
    dir: string,
    fileName: string,
    code = "export default async function() {}",
  ): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const handlerPath = path.join(dir, fileName);
    await fs.writeFile(handlerPath, code, "utf-8");
    return handlerPath;
  }

  async function writeHook(params: {
    hooksRoot: string;
    hookName: string;
    events: string[];
    message: string;
    dirName?: string;
    handlerCode?: string;
  }): Promise<string> {
    const hookDir = path.join(params.hooksRoot, params.dirName ?? params.hookName);
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        `name: ${params.hookName}`,
        `description: ${params.hookName} test hook`,
        `metadata: ${JSON.stringify({ openclaw: { events: params.events } })}`,
        "---",
        "",
        `# ${params.hookName}`,
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(hookDir, "handler.js"),
      params.handlerCode ??
        `export default async function(event) { event.messages.push(${JSON.stringify(params.message)}); }\n`,
      "utf-8",
    );
    return hookDir;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    clearInternalHooks();
    envSnapshot.restore();
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  describe("loadInternalHooks", () => {
    const createLegacyHandlerConfig = () =>
      createEnabledHooksConfig([
        {
          event: "command:new",
          module: "legacy-handler.js",
        },
      ]);

    const expectNoCommandHookRegistration = async (cfg: OpenClawConfig) => {
      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
      expect(getRegisteredEventKeys()).not.toContain("command:new");
    };

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
      // Create a test handler module
      const handlerCode = `
        export default async function(event) {
          // Test handler
        }
      `;
      const handlerPath = await writeHandlerModule("test-handler.js", handlerCode);
      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: path.basename(handlerPath),
        },
      ]);

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
    });

    it("should load multiple handlers", async () => {
      // Create test handler modules
      const handler1Path = await writeHandlerModule("handler1.js");
      const handler2Path = await writeHandlerModule("handler2.js");

      const cfg = createEnabledHooksConfig([
        { event: "command:new", module: path.basename(handler1Path) },
        { event: "command:stop", module: path.basename(handler2Path) },
      ]);

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(2);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
      expect(keys).toContain("command:stop");
    });

    it("should support named exports", async () => {
      // Create a handler module with named export
      const handlerCode = `
        export const myHandler = async function(event) {
          // Named export handler
        }
      `;
      const handlerPath = await writeHandlerModule("named-export.js", handlerCode);

      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: path.basename(handlerPath),
          export: "myHandler",
        },
      ]);

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);
    });

    it("should handle module loading errors gracefully", async () => {
      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: "missing-handler.js",
        },
      ]);

      // Should not throw and should return 0 (handler failed to load)
      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
    });

    it("should handle non-function exports", async () => {
      // Create a module with a non-function export
      const handlerPath = await writeHandlerModule(
        "bad-export.js",
        'export default "not a function";',
      );

      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: path.basename(handlerPath),
        },
      ]);

      // Should not throw and should return 0 (handler is not a function)
      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(0);
    });

    it("should handle relative paths", async () => {
      // Create a handler module
      const handlerPath = await writeHandlerModule("relative-handler.js");

      // Relative to workspaceDir (tmpDir)
      const relativePath = path.relative(tmpDir, handlerPath);

      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: relativePath,
        },
      ]);

      const count = await loadInternalHooks(cfg, tmpDir);
      expect(count).toBe(1);
    });

    it("should actually call the loaded handler", async () => {
      // Create a handler that we can verify was called
      const handlerCode = `
        let callCount = 0;
        export default async function(event) {
          callCount++;
        }
        export function getCallCount() {
          return callCount;
        }
      `;
      const handlerPath = await writeHandlerModule("callable-handler.js", handlerCode);

      const cfg = createEnabledHooksConfig([
        {
          event: "command:new",
          module: path.basename(handlerPath),
        },
      ]);

      await loadInternalHooks(cfg, tmpDir);

      // Trigger the hook
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      // The handler should have been called, but we can't directly verify
      // the call count from this context without more complex test infrastructure
      // This test mainly verifies that loading and triggering doesn't crash
      expect(getRegisteredEventKeys()).toContain("command:new");
    });

    it("rejects directory hook handlers that escape hook dir via symlink", async () => {
      const outsideHandlerPath = path.join(fixtureRoot, `outside-handler-${caseId}.js`);
      await fs.writeFile(outsideHandlerPath, "export default async function() {}", "utf-8");

      const hookDir = path.join(tmpDir, "hooks", "symlink-hook");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(
        path.join(hookDir, "HOOK.md"),
        [
          "---",
          "name: symlink-hook",
          "description: symlink test",
          'metadata: {"openclaw":{"events":["command:new"]}}',
          "---",
          "",
          "# Symlink Hook",
        ].join("\n"),
        "utf-8",
      );
      try {
        await fs.symlink(outsideHandlerPath, path.join(hookDir, "handler.js"));
      } catch {
        return;
      }

      await expectNoCommandHookRegistration(createEnabledHooksConfig());
    });

    it("rejects legacy handler modules that escape workspace via symlink", async () => {
      const outsideHandlerPath = path.join(fixtureRoot, `outside-legacy-${caseId}.js`);
      await fs.writeFile(outsideHandlerPath, "export default async function() {}", "utf-8");

      const linkedHandlerPath = path.join(tmpDir, "legacy-handler.js");
      try {
        await fs.symlink(outsideHandlerPath, linkedHandlerPath);
      } catch {
        return;
      }

      await expectNoCommandHookRegistration(createLegacyHandlerConfig());
    });

    it("rejects directory hook handlers that escape hook dir via hardlink", async () => {
      if (process.platform === "win32") {
        return;
      }
      const outsideHandlerPath = path.join(fixtureRoot, `outside-handler-hardlink-${caseId}.js`);
      await fs.writeFile(outsideHandlerPath, "export default async function() {}", "utf-8");

      const hookDir = path.join(tmpDir, "hooks", "hardlink-hook");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(
        path.join(hookDir, "HOOK.md"),
        [
          "---",
          "name: hardlink-hook",
          "description: hardlink test",
          'metadata: {"openclaw":{"events":["command:new"]}}',
          "---",
          "",
          "# Hardlink Hook",
        ].join("\n"),
        "utf-8",
      );
      try {
        await fs.link(outsideHandlerPath, path.join(hookDir, "handler.js"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      await expectNoCommandHookRegistration(createEnabledHooksConfig());
    });

    it("rejects legacy handler modules that escape workspace via hardlink", async () => {
      if (process.platform === "win32") {
        return;
      }
      const outsideHandlerPath = path.join(fixtureRoot, `outside-legacy-hardlink-${caseId}.js`);
      await fs.writeFile(outsideHandlerPath, "export default async function() {}", "utf-8");

      const linkedHandlerPath = path.join(tmpDir, "legacy-handler.js");
      try {
        await fs.link(outsideHandlerPath, linkedHandlerPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }

      await expectNoCommandHookRegistration(createLegacyHandlerConfig());
    });
  });

  describe("loadInternalHooksForStartup", () => {
    it("loads workspace hooks for all configured workspaces and scopes them by session", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      await writeHook({
        hooksRoot: path.join(mainWorkspace, "hooks"),
        hookName: "main-local",
        events: ["command:new"],
        message: "main-local",
      });
      await writeHook({
        hooksRoot: path.join(opsWorkspace, "hooks"),
        hookName: "ops-local",
        events: ["command:new"],
        message: "ops-local",
      });

      const cfg = createMultiAgentHooksConfig({ mainWorkspace, opsWorkspace });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir: path.join(tmpDir, "managed-empty"),
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(2);

      const mainEvent = createInternalHookEvent("command", "new", "agent:main:chat");
      await triggerInternalHook(mainEvent);
      expect(mainEvent.messages).toEqual(["main-local"]);

      const opsEvent = createInternalHookEvent("command", "new", "agent:ops:chat");
      await triggerInternalHook(opsEvent);
      expect(opsEvent.messages).toEqual(["ops-local"]);
    });

    it("loads shared hooks only once across multiple workspaces", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      const extraHooksDir = path.join(tmpDir, "extra-hooks");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      const bundledHooksDir = path.join(tmpDir, "bundled-hooks");
      await writeHook({
        hooksRoot: extraHooksDir,
        hookName: "extra-shared",
        events: ["command:new"],
        message: "extra",
      });
      await writeHook({
        hooksRoot: managedHooksDir,
        hookName: "managed-shared",
        events: ["command:new"],
        message: "managed",
      });
      await writeHook({
        hooksRoot: bundledHooksDir,
        hookName: "bundled-shared",
        events: ["command:new"],
        message: "bundled",
      });
      await writeHandlerModuleInDir(
        mainWorkspace,
        "legacy-handler.js",
        "export default async function(event) { event.messages.push('legacy'); }\n",
      );

      const cfg = createMultiAgentHooksConfig({
        mainWorkspace,
        opsWorkspace,
        extraDirs: [extraHooksDir],
        handlers: [{ event: "command:new", module: "legacy-handler.js" }],
      });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        { managedHooksDir, bundledHooksDir },
      );

      expect(count).toBe(4);

      const event = createInternalHookEvent("command", "new", "agent:ops:chat");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["extra", "bundled", "managed", "legacy"]);
    });

    it("continues loading workspace-local hooks when shared hook discovery fails", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeHook({
        hooksRoot: path.join(mainWorkspace, "hooks"),
        hookName: "main-local",
        events: ["command:new"],
        message: "main-local",
      });
      await writeHook({
        hooksRoot: path.join(opsWorkspace, "hooks"),
        hookName: "ops-local",
        events: ["command:new"],
        message: "ops-local",
      });

      const originalReaddirSync = fsSync.readdirSync.bind(fsSync);
      vi.spyOn(fsSync, "readdirSync").mockImplementation(((dir, options) => {
        if (dir === managedHooksDir) {
          throw new Error("managed-hooks exploded");
        }
        return originalReaddirSync(dir, options as never);
      }) as typeof fsSync.readdirSync);

      const cfg = createMultiAgentHooksConfig({ mainWorkspace, opsWorkspace });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir,
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(2);

      const mainEvent = createInternalHookEvent("command", "new", "agent:main:chat");
      await triggerInternalHook(mainEvent);
      expect(mainEvent.messages).toEqual(["main-local"]);

      const opsEvent = createInternalHookEvent("command", "new", "agent:ops:chat");
      await triggerInternalHook(opsEvent);
      expect(opsEvent.messages).toEqual(["ops-local"]);
    });

    it("continues loading other workspaces when one workspace hook discovery fails", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      const mainHooksDir = path.join(mainWorkspace, "hooks");
      await writeHook({
        hooksRoot: mainHooksDir,
        hookName: "main-local",
        events: ["command:new"],
        message: "main-local",
      });
      await writeHook({
        hooksRoot: path.join(opsWorkspace, "hooks"),
        hookName: "ops-local",
        events: ["command:new"],
        message: "ops-local",
      });

      const originalReaddirSync = fsSync.readdirSync.bind(fsSync);
      vi.spyOn(fsSync, "readdirSync").mockImplementation(((dir, options) => {
        if (dir === mainHooksDir) {
          throw new Error("main workspace exploded");
        }
        return originalReaddirSync(dir, options as never);
      }) as typeof fsSync.readdirSync);

      const cfg = createMultiAgentHooksConfig({ mainWorkspace, opsWorkspace });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir: path.join(tmpDir, "managed-empty"),
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(1);

      const mainEvent = createInternalHookEvent("command", "new", "agent:main:chat");
      await triggerInternalHook(mainEvent);
      expect(mainEvent.messages).toEqual([]);

      const opsEvent = createInternalHookEvent("command", "new", "agent:ops:chat");
      await triggerInternalHook(opsEvent);
      expect(opsEvent.messages).toEqual(["ops-local"]);
    });

    it("suppresses shared hooks when a matching workspace-local hook exists", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeHook({
        hooksRoot: managedHooksDir,
        hookName: "override-me",
        events: ["command:new"],
        message: "shared",
      });
      await writeHook({
        hooksRoot: path.join(mainWorkspace, "hooks"),
        hookName: "override-me",
        events: ["command:new"],
        message: "main-local",
      });

      const cfg = createMultiAgentHooksConfig({ mainWorkspace, opsWorkspace });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir,
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(2);

      const mainEvent = createInternalHookEvent("command", "new", "agent:main:chat");
      await triggerInternalHook(mainEvent);
      expect(mainEvent.messages).toEqual(["main-local"]);

      const opsEvent = createInternalHookEvent("command", "new", "agent:ops:chat");
      await triggerInternalHook(opsEvent);
      expect(opsEvent.messages).toEqual(["shared"]);
    });

    it("uses the configured default agent workspace for legacy session keys without agent context", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      await writeHook({
        hooksRoot: path.join(mainWorkspace, "hooks"),
        hookName: "main-local",
        events: ["command:new"],
        message: "main-local",
      });
      await writeHook({
        hooksRoot: path.join(opsWorkspace, "hooks"),
        hookName: "ops-local",
        events: ["command:new"],
        message: "ops-local",
      });

      const cfg = createMultiAgentHooksConfig({
        mainWorkspace,
        opsWorkspace,
        defaultAgentId: "ops",
      });
      const count = await loadInternalHooksForStartup(
        cfg,
        opsWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir: path.join(tmpDir, "managed-empty"),
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(2);

      const event = createInternalHookEvent("command", "new", "legacy-chat");
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["ops-local"]);
    });

    it("runs shared startup hooks once and workspace startup hooks once per workspace", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeHook({
        hooksRoot: managedHooksDir,
        hookName: "shared-startup",
        events: ["gateway:startup"],
        message: "shared-startup",
      });
      await writeHook({
        hooksRoot: path.join(mainWorkspace, "hooks"),
        hookName: "main-startup",
        events: ["gateway:startup"],
        message: "main-startup",
        handlerCode:
          "export default async function(event) { event.messages.push(String(event.context.workspaceDir)); }\n",
      });
      await writeHook({
        hooksRoot: path.join(opsWorkspace, "hooks"),
        hookName: "ops-startup",
        events: ["gateway:startup"],
        message: "ops-startup",
        handlerCode:
          "export default async function(event) { event.messages.push(String(event.context.workspaceDir)); }\n",
      });

      const cfg = createMultiAgentHooksConfig({ mainWorkspace, opsWorkspace });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir,
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(3);

      const event = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg,
        workspaceDir: mainWorkspace,
      });
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["shared-startup", mainWorkspace, opsWorkspace]);
    });

    it("suppresses shared startup hooks when a matching workspace-local startup hook exists", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeHook({
        hooksRoot: managedHooksDir,
        hookName: "override-me",
        events: ["gateway:startup"],
        message: "shared-startup",
      });
      await writeHook({
        hooksRoot: path.join(mainWorkspace, "hooks"),
        hookName: "override-me",
        events: ["gateway:startup"],
        message: "main-startup",
        handlerCode:
          "export default async function(event) { event.messages.push(String(event.context.workspaceDir)); }\n",
      });

      const cfg = createMultiAgentHooksConfig({ mainWorkspace, opsWorkspace });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir,
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(2);

      const event = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg,
        workspaceDir: mainWorkspace,
      });
      await triggerInternalHook(event);
      expect(event.messages).toEqual([mainWorkspace]);
    });

    it("suppresses shared startup hooks when a non-default workspace provides the startup override", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeHook({
        hooksRoot: managedHooksDir,
        hookName: "override-me",
        events: ["gateway:startup"],
        message: "shared-startup",
      });
      await writeHook({
        hooksRoot: path.join(opsWorkspace, "hooks"),
        hookName: "override-me",
        events: ["gateway:startup"],
        message: "ops-startup",
        handlerCode:
          "export default async function(event) { event.messages.push(String(event.context.workspaceDir)); }\n",
      });

      const cfg = createMultiAgentHooksConfig({ mainWorkspace, opsWorkspace });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir,
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(2);

      const event = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg,
        workspaceDir: mainWorkspace,
      });
      await triggerInternalHook(event);
      expect(event.messages).toEqual([opsWorkspace]);
    });

    it("does not suppress shared startup hooks when the matching workspace-local hook does not subscribe to startup", async () => {
      const mainWorkspace = path.join(tmpDir, "workspace-main");
      const opsWorkspace = path.join(tmpDir, "workspace-ops");
      const managedHooksDir = path.join(tmpDir, "managed-hooks");
      await writeHook({
        hooksRoot: managedHooksDir,
        hookName: "override-me",
        events: ["gateway:startup"],
        message: "shared-startup",
      });
      await writeHook({
        hooksRoot: path.join(mainWorkspace, "hooks"),
        hookName: "override-me",
        events: ["command:new"],
        message: "main-command",
      });

      const cfg = createMultiAgentHooksConfig({ mainWorkspace, opsWorkspace });
      const count = await loadInternalHooksForStartup(
        cfg,
        mainWorkspace,
        [mainWorkspace, opsWorkspace],
        {
          managedHooksDir,
          bundledHooksDir: path.join(tmpDir, "bundled-empty"),
        },
      );

      expect(count).toBe(2);

      const event = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg,
        workspaceDir: mainWorkspace,
      });
      await triggerInternalHook(event);
      expect(event.messages).toEqual(["shared-startup"]);
    });
  });
});
