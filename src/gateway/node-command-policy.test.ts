/**
 * Node command policy regression tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type {
  PluginNodeHostCommandRegistration,
  PluginNodeInvokePolicyRegistration,
} from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  isForegroundRestrictedPluginNodeCommand,
  isNodeCommandAllowed,
  listDangerousPluginNodeCommands,
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";

describe("gateway/node-command-policy", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  function createCanvasPolicyRegistration(): PluginNodeInvokePolicyRegistration {
    return {
      pluginId: "canvas",
      pluginName: "Canvas",
      source: "/extensions/canvas/index.ts",
      rootDir: "/extensions/canvas",
      pluginConfig: {},
      policy: {
        commands: ["canvas.snapshot", "canvas.present"],
        defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
        foregroundRestrictedOnIos: true,
        handle: (ctx) => ctx.invokeNode(),
      },
    };
  }

  function createUnreadablePolicyRegistration(): PluginNodeInvokePolicyRegistration {
    return {
      pluginId: "bad-policy",
      source: "/extensions/bad/index.ts",
      get policy() {
        throw new Error("node command policy getter exploded");
      },
    };
  }

  function createUnreadableNodeHostCommandRegistration(): PluginNodeHostCommandRegistration {
    return {
      pluginId: "bad-command",
      source: "/extensions/bad/index.ts",
      get command() {
        throw new Error("node command metadata getter exploded");
      },
    };
  }

  function createUnreadableDangerousPolicyRegistration(): PluginNodeInvokePolicyRegistration {
    return {
      pluginId: "dangerous-policy",
      source: "/extensions/bad/index.ts",
      policy: {
        commands: ["dangerous.default"],
        defaultPlatforms: ["windows"],
        get dangerous() {
          throw new Error("node policy dangerous getter exploded");
        },
        handle: (ctx) => ctx.invokeNode(),
      },
    };
  }

  function createDangerousPolicyWithUnreadableDefaults(): PluginNodeInvokePolicyRegistration {
    return {
      pluginId: "dangerous-policy",
      source: "/extensions/bad/index.ts",
      policy: {
        commands: ["dangerous.default"],
        get defaultPlatforms() {
          throw new Error("node policy defaultPlatforms getter exploded");
        },
        dangerous: true,
        handle: (ctx) => ctx.invokeNode(),
      },
    };
  }

  function createUnreadableDangerousNodeHostCommandRegistration(): PluginNodeHostCommandRegistration {
    return {
      pluginId: "dangerous-command",
      source: "/extensions/bad/index.ts",
      command: {
        command: "plugin.exec",
        get dangerous() {
          throw new Error("node command dangerous getter exploded");
        },
        handle: async () => "{}",
      },
    };
  }

  function installCanvasPluginDefaults() {
    const registry = createEmptyPluginRegistry();
    (registry.nodeInvokePolicies ??= []).push(createCanvasPolicyRegistration());
    setActivePluginRegistry(registry);
  }

  function installUnreadableDangerousPolicy() {
    const registry = createEmptyPluginRegistry();
    (registry.nodeInvokePolicies ??= []).push(createUnreadableDangerousPolicyRegistration());
    setActivePluginRegistry(registry);
  }

  function installDangerousPolicyWithUnreadableDefaults() {
    const registry = createEmptyPluginRegistry();
    (registry.nodeInvokePolicies ??= []).push(createDangerousPolicyWithUnreadableDefaults());
    setActivePluginRegistry(registry);
  }

  function installUnreadableDangerousNodeHostCommand() {
    const registry = createEmptyPluginRegistry();
    (registry.nodeHostCommands ??= []).push(createUnreadableDangerousNodeHostCommandRegistration());
    setActivePluginRegistry(registry);
  }

  function installCanvasPluginDefaultsWithUnreadableSibling() {
    const registry = createEmptyPluginRegistry();
    (registry.nodeInvokePolicies ??= []).push(
      createUnreadablePolicyRegistration(),
      createCanvasPolicyRegistration(),
    );
    setActivePluginRegistry(registry);
  }

  function installUnreadableNodeHostCommandSibling() {
    const registry = createEmptyPluginRegistry();
    (registry.nodeHostCommands ??= []).push(createUnreadableNodeHostCommandRegistration());
    (registry.nodeInvokePolicies ??= []).push(createCanvasPolicyRegistration());
    setActivePluginRegistry(registry);
  }

  it("normalizes declared node commands against the allowlist", () => {
    const allowlist = new Set(["canvas.snapshot", "system.run"]);
    expect(
      normalizeDeclaredNodeCommands({
        declaredCommands: [" canvas.snapshot ", "", "system.run", "system.run", "screen.record"],
        allowlist,
      }),
    ).toEqual(["canvas.snapshot", "system.run"]);
  });

  it("allows declared push-to-talk commands on trusted talk-capable nodes", () => {
    const cfg = {} as OpenClawConfig;
    for (const platform of ["ios", "android", "macos", "other"]) {
      const allowlist = resolveNodeCommandAllowlist(cfg, { platform, caps: ["talk"] });
      expect(allowlist.has("talk.ptt.start")).toBe(true);
      expect(allowlist.has("talk.ptt.stop")).toBe(true);
      expect(allowlist.has("talk.ptt.cancel")).toBe(true);
      expect(allowlist.has("talk.ptt.once")).toBe(true);
      expect(
        isNodeCommandAllowed({
          command: "talk.ptt.start",
          declaredCommands: ["talk.ptt.start"],
          allowlist,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("does not allow push-to-talk commands from platform label alone", () => {
    const cfg = {} as OpenClawConfig;
    const allowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "android",
      caps: ["device"],
      commands: [],
    });

    expect(allowlist.has("talk.ptt.start")).toBe(false);
  });

  it("allows push-to-talk commands when the node declares talk command support", () => {
    const cfg = {} as OpenClawConfig;
    const allowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "custom",
      commands: ["talk.ptt.start"],
    });

    expect(allowlist.has("talk.ptt.start")).toBe(true);
  });

  it("keeps canvas commands out of core defaults when the canvas plugin is not active", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
    });

    expect(allowlist.has("canvas.snapshot")).toBe(false);
  });

  it("adds canvas commands from the active canvas plugin node policy", () => {
    installCanvasPluginDefaults();

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
    });

    expect(allowlist.has("canvas.snapshot")).toBe(true);
    expect(allowlist.has("canvas.present")).toBe(true);
  });

  it("skips unreadable plugin policy siblings while preserving default commands", () => {
    installCanvasPluginDefaultsWithUnreadableSibling();

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
    });

    expect(allowlist.has("canvas.snapshot")).toBe(true);
    expect(allowlist.has("canvas.present")).toBe(true);
  });

  it("skips unreadable dangerous command siblings while preserving default commands", () => {
    installUnreadableNodeHostCommandSibling();

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
    });

    expect(allowlist.has("canvas.snapshot")).toBe(true);
    expect(allowlist.has("canvas.present")).toBe(true);
  });

  it("treats unreadable plugin policy dangerous metadata as dangerous", () => {
    installUnreadableDangerousPolicy();

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
    });

    expect(allowlist.has("dangerous.default")).toBe(false);
    expect(listDangerousPluginNodeCommands()).toEqual(["dangerous.default"]);
  });

  it("keeps dangerous metadata when policy default platforms are unreadable", () => {
    installDangerousPolicyWithUnreadableDefaults();

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
    });

    expect(allowlist.has("dangerous.default")).toBe(false);
    expect(listDangerousPluginNodeCommands()).toEqual(["dangerous.default"]);
  });

  it("treats unreadable node host command dangerous metadata as dangerous", () => {
    installUnreadableDangerousNodeHostCommand();

    expect(listDangerousPluginNodeCommands()).toEqual(["plugin.exec"]);
  });

  it("does not grant host command defaults for platform prefix aliases", () => {
    const cfg = {} as OpenClawConfig;
    const cases = [
      { platform: "darwin", deviceFamily: "iPhone" },
      { platform: "darwin", deviceFamily: "Mac" },
      { platform: "macos" },
      { platform: "macos", deviceFamily: "Mac" },
      { platform: "macos", deviceFamily: "iPhone" },
      { platform: "macOS 26.3.1", deviceFamily: "iPhone" },
      { platform: "macOS 26.3.1", deviceFamily: "Mac" },
      { platform: "windows" },
      { platform: "windows", deviceFamily: "Windows" },
      { platform: "windows", deviceFamily: "iPhone" },
      { platform: "linux" },
      { platform: "linux", deviceFamily: "Linux" },
      { platform: "linux", deviceFamily: "iPhone" },
      { platform: "Darwin-x64" },
      { platform: "macintosh" },
      { platform: "win32" },
      { platform: "linux-gnu" },
      {
        platform: "macos",
        deviceFamily: "Mac",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      },
    ];

    for (const node of cases) {
      const allowlist = resolveNodeCommandAllowlist(cfg, node);
      expect(allowlist.has("system.run")).toBe(false);
      expect(allowlist.has("system.run.prepare")).toBe(false);
      expect(allowlist.has("system.which")).toBe(false);
      expect(allowlist.has("browser.proxy")).toBe(false);
      expect(allowlist.has("screen.snapshot")).toBe(false);
      expect(allowlist.has("system.notify")).toBe(true);
    }
  });

  it("keeps defaults for first-party native platform labels with matching families", () => {
    const cfg = {} as OpenClawConfig;

    const iosAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "iOS 18.4.0",
      deviceFamily: "iPhone",
    });
    expect(iosAllowlist.has("device.info")).toBe(true);
    expect(iosAllowlist.has("photos.latest")).toBe(true);
    expect(iosAllowlist.has("system.run")).toBe(false);

    const ipadAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "iPadOS 18.4.0",
      deviceFamily: "iPad",
    });
    expect(ipadAllowlist.has("device.info")).toBe(true);
    expect(ipadAllowlist.has("motion.activity")).toBe(true);
    expect(ipadAllowlist.has("system.run")).toBe(false);

    const macAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "macOS 15.5.0",
      deviceFamily: "Mac",
    });
    expect(macAllowlist.has("system.run")).toBe(false);
    expect(macAllowlist.has("system.which")).toBe(false);
    expect(macAllowlist.has("screen.snapshot")).toBe(false);
  });

  it("keeps explicitly approved host commands for desktop platforms", () => {
    const cfg = {} as OpenClawConfig;
    const cases = [
      { platform: "macos", deviceFamily: "Mac" },
      { platform: "windows", deviceFamily: "Windows" },
      { platform: "linux", deviceFamily: "Linux" },
    ];

    for (const node of cases) {
      const allowlist = resolveNodeCommandAllowlist(cfg, {
        ...node,
        approvedCommands: ["system.run", "system.which"],
      });
      expect(allowlist.has("system.run")).toBe(true);
      expect(allowlist.has("system.which")).toBe(true);
    }
  });

  it("keeps approved host commands on live desktop node sessions", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      nodeId: "node-1",
      connId: "conn-1",
      platform: "linux",
      deviceFamily: "Linux",
      commands: ["browser.proxy", "system.run"],
    });

    expect(allowlist.has("browser.proxy")).toBe(true);
    expect(allowlist.has("system.run")).toBe(true);
  });

  it("does not treat unconnected declared host commands as approved", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "linux",
      deviceFamily: "Linux",
      commands: ["browser.proxy", "system.run"],
    });

    expect(allowlist.has("browser.proxy")).toBe(false);
    expect(allowlist.has("system.run")).toBe(false);
  });

  it("does not grandfather approved non-default commands after config removal", () => {
    const staleApproval = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "macos",
      deviceFamily: "Mac",
      approvedCommands: ["screen.record"],
    });
    expect(staleApproval.has("screen.record")).toBe(false);

    const currentConfigApproval = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            allowCommands: ["screen.record"],
          },
        },
      } as OpenClawConfig,
      {
        platform: "macos",
        deviceFamily: "Mac",
        approvedCommands: ["screen.record"],
      },
    );
    expect(currentConfigApproval.has("screen.record")).toBe(true);
  });

  it("reads foreground restriction metadata from plugin node policies", () => {
    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(false);

    installCanvasPluginDefaults();

    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(true);
    expect(isForegroundRestrictedPluginNodeCommand("system.run")).toBe(false);
  });

  it("skips unreadable foreground restriction siblings while preserving matching metadata", () => {
    installCanvasPluginDefaultsWithUnreadableSibling();

    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(true);
  });
});
