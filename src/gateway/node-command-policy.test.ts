/**
 * Node command policy regression tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NODE_WORKER_PRIVATE_COMMANDS } from "../infra/node-commands.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import {
  isForegroundRestrictedPluginNodeCommand,
  isNodeCommandAllowed,
  listDangerousPluginNodeCommands,
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
  resolveNodePairingCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
} from "./node-command-policy.js";
import {
  filterLegacyNodeProtocolFeatures,
  normalizeNodeHostCompatibilityMetadata,
} from "./node-legacy-protocol-filter.js";

describe("gateway/node-command-policy", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  function installCanvasPluginDefaults() {
    const registry = createEmptyPluginRegistry();
    registry.nodeInvokePolicies.push({
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
    });
    setActivePluginRegistry(registry);
    return registry;
  }

  it("allows paired desktop streaming without a persistent allow and keeps deny-wins", () => {
    const node = {
      platform: "linux",
      deviceFamily: "Linux",
      commands: [NODE_DESKTOP_STREAM_COMMAND],
      approvedCommands: [NODE_DESKTOP_STREAM_COMMAND],
    };
    expect(
      resolveNodeCommandAllowlist({} as OpenClawConfig, node).has(NODE_DESKTOP_STREAM_COMMAND),
    ).toBe(true);
    expect(
      resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
        platform: node.platform,
        deviceFamily: node.deviceFamily,
        commands: node.commands,
      }).has(NODE_DESKTOP_STREAM_COMMAND),
    ).toBe(true);

    const allowed = resolveNodeCommandAllowlist({}, node);
    expect(
      isNodeCommandAllowed({
        command: NODE_DESKTOP_STREAM_COMMAND,
        declaredCommands: node.commands,
        allowlist: allowed,
      }),
    ).toEqual({ ok: true });
    expect(
      isNodeCommandAllowed({
        command: NODE_DESKTOP_STREAM_COMMAND,
        declaredCommands: [],
        allowlist: allowed,
      }),
    ).toEqual({ ok: false, reason: "node did not declare commands" });
    expect(
      resolveNodeCommandAllowlist({}, { ...node, approvedCommands: [] }).has(
        NODE_DESKTOP_STREAM_COMMAND,
      ),
    ).toBe(false);

    const denied = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            commands: {
              allow: [NODE_DESKTOP_STREAM_COMMAND],
              deny: [NODE_DESKTOP_STREAM_COMMAND],
            },
          },
        },
      } as OpenClawConfig,
      node,
    );
    expect(denied.has(NODE_DESKTOP_STREAM_COMMAND)).toBe(false);
  });

  it("does not add desktop streaming to unknown-platform pairing", () => {
    expect(
      resolveNodePairingCommandAllowlist({}, { platform: "unknown", deviceFamily: "unknown" }).has(
        NODE_DESKTOP_STREAM_COMMAND,
      ),
    ).toBe(false);
  });

  it("keeps private worker supervisor commands outside public policy", () => {
    const cfg = {
      gateway: { nodes: { commands: { allow: [...NODE_WORKER_PRIVATE_COMMANDS] } } },
    } as OpenClawConfig;
    const node = {
      platform: "linux",
      deviceFamily: "Linux",
      commands: [...NODE_WORKER_PRIVATE_COMMANDS],
      approvedCommands: [...NODE_WORKER_PRIVATE_COMMANDS],
    };

    expect([...resolveNodeCommandAllowlist(cfg, node)]).not.toEqual(
      expect.arrayContaining([...NODE_WORKER_PRIVATE_COMMANDS]),
    );
    expect([...resolveNodePairingCommandAllowlist(cfg, node)]).not.toEqual(
      expect.arrayContaining([...NODE_WORKER_PRIVATE_COMMANDS]),
    );
  });

  it("keeps safe PTZ status Mac-only and requires an explicit allow for control", () => {
    const macNode = {
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["camera.ptz.status", "camera.ptz.control"],
    };
    const defaultAllowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, macNode);
    expect(defaultAllowlist.has("camera.ptz.status")).toBe(true);
    expect(defaultAllowlist.has("camera.ptz.control")).toBe(false);

    for (const platform of ["ios", "android", "windows", "linux", "unknown"]) {
      const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, { platform });
      expect(allowlist.has("camera.ptz.status")).toBe(false);
      expect(allowlist.has("camera.ptz.control")).toBe(false);
    }

    const explicitAllow = resolveNodeCommandAllowlist(
      {
        gateway: { nodes: { commands: { allow: ["camera.ptz.control"] } } },
      } as OpenClawConfig,
      macNode,
    );
    expect(explicitAllow.has("camera.ptz.control")).toBe(true);

    const denied = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            commands: {
              allow: ["camera.ptz.control"],
              deny: ["camera.ptz.control"],
            },
          },
        },
      } as OpenClawConfig,
      macNode,
    );
    expect(denied.has("camera.ptz.control")).toBe(false);
  });

  it("suppresses plugin-owned features for legacy protocol nodes", () => {
    installCanvasPluginDefaults();

    expect(
      filterLegacyNodeProtocolFeatures({
        caps: ["canvas", "device"],
        commands: ["canvas.snapshot", "device.info"],
        pluginSurfaces: ["canvas"],
      }),
    ).toEqual({
      caps: ["device"],
      commands: ["device.info"],
    });
  });

  it("preserves native command ids when a plugin provides another host implementation", () => {
    const registry = createEmptyPluginRegistry();
    for (const command of [
      "system.notify",
      "camera.list",
      "camera.snap",
      "camera.clip",
      "camera.ptz.status",
      "camera.ptz.control",
      "location.get",
      "remote.echo",
    ]) {
      registry.nodeHostCommands.push({
        pluginId: command === "remote.echo" ? "remote" : "linux-node",
        pluginName: command === "remote.echo" ? "Remote" : "Linux Node",
        command: { command, handle: async () => "{}" },
        source: "test",
      });
    }
    setActivePluginRegistry(registry);

    expect(
      filterLegacyNodeProtocolFeatures({
        caps: ["camera", "location", "device"],
        commands: [
          "system.notify",
          "camera.list",
          "camera.snap",
          "camera.clip",
          "camera.ptz.status",
          "camera.ptz.control",
          "location.get",
          "remote.echo",
          "device.info",
        ],
        pluginSurfaces: [],
      }),
    ).toEqual({
      caps: ["camera", "location", "device"],
      commands: [
        "system.notify",
        "camera.list",
        "camera.snap",
        "camera.clip",
        "camera.ptz.status",
        "camera.ptz.control",
        "location.get",
        "device.info",
      ],
    });
  });

  it("normalizes shipped protocol-v3 node-host metadata", () => {
    const normalized = normalizeNodeHostCompatibilityMetadata({
      id: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "2026.5.7",
      platform: "darwin",
      mode: GATEWAY_CLIENT_MODES.NODE,
    });
    expect(normalized).toMatchObject({ platform: "macos", deviceFamily: "Mac" });
    expect(
      resolveNodeCommandAllowlist({} as OpenClawConfig, {
        ...normalized,
        approvedCommands: ["system.run"],
      }).has("system.run"),
    ).toBe(true);
  });

  it("does not normalize non-node-host or conflicting legacy metadata", () => {
    const conflicting = {
      id: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "2026.5.7",
      platform: "linux",
      deviceFamily: "iPhone",
      mode: GATEWAY_CLIENT_MODES.NODE,
    } as const;
    expect(normalizeNodeHostCompatibilityMetadata(conflicting)).toBe(conflicting);

    const otherClient = {
      ...conflicting,
      id: GATEWAY_CLIENT_IDS.LINUX_APP,
      deviceFamily: undefined,
    };
    expect(normalizeNodeHostCompatibilityMetadata(otherClient)).toBe(otherClient);
  });

  it("does not normalize inherited platform keys", () => {
    const client = {
      id: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "2026.5.7",
      platform: "__proto__",
      deviceFamily: "Mac",
      mode: GATEWAY_CLIENT_MODES.NODE,
    } as const;

    expect(normalizeNodeHostCompatibilityMetadata(client)).toBe(client);
  });

  it("preserves registered node command order, opt-in policy, and registry replacement", () => {
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const api = builder.createApi(
      createPluginRecord({
        id: "remote",
        source: "/plugins/remote/index.ts",
        origin: "global",
        enabled: true,
        configSchema: false,
      }),
      { config: {} },
    );
    const handle = async () => {
      throw new Error("collecting node command metadata must not invoke a handler");
    };
    for (const [command, dangerous, defaults] of [
      [" remote.echo ", false, ["linux"]],
      ["remote.shared", false, ["linux"]],
      ["remote.manual", false, []],
      ["remote.dangerous", true, ["linux"]],
    ] as const) {
      api.registerNodeHostCommand({
        command,
        dangerous,
        agentTool: {
          name: command.trim().replaceAll(".", "_"),
          description: "Registered node-host command",
          ...(defaults.length ? { defaultPlatforms: [...defaults] } : {}),
        },
        handle,
      });
    }
    const commands = [" remote.policy ", "remote.shared", "remote.policy"];
    api.registerNodeInvokePolicy({ commands, defaultPlatforms: ["linux"], handle });
    api.registerNodeInvokePolicy({
      commands: ["remote.policy-danger", "remote.dangerous"],
      dangerous: true,
      defaultPlatforms: ["linux"],
      handle,
    });
    expect(builder.registry.diagnostics).toEqual([]);
    setActivePluginRegistry(builder.registry);
    const node = { platform: "linux", deviceFamily: "Linux" };
    const allowlist = resolveNodeCommandAllowlist({}, node);
    expect([...allowlist]).toEqual([
      "system.notify",
      "computer.act",
      "remote.policy",
      "remote.shared",
      "remote.echo",
    ]);
    expect(
      normalizeDeclaredNodeCommands({
        declaredCommands: ["remote.echo", "remote.dangerous"],
        allowlist,
      }),
    ).toEqual(["remote.echo"]);
    const dangerous = listDangerousPluginNodeCommands();
    expect(dangerous).toEqual(["remote.dangerous", "remote.policy-danger"]);
    dangerous.push("remote.returned-array-mutation");
    commands.push("remote.registration-input-mutation");
    expect(listDangerousPluginNodeCommands()).toEqual(["remote.dangerous", "remote.policy-danger"]);
    expect(resolveNodeCommandAllowlist({}, node)).toEqual(allowlist);
    expect([
      ...resolveNodeCommandAllowlist(
        {
          gateway: {
            nodes: {
              commands: {
                allow: ["remote.policy-danger", "remote.dangerous"],
                deny: ["remote.shared", "remote.policy-danger"],
              },
            },
          },
        },
        node,
      ),
    ]).toEqual([
      "system.notify",
      "computer.act",
      "remote.policy",
      "remote.echo",
      "remote.dangerous",
    ]);
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(listDangerousPluginNodeCommands()).toEqual([]);
    expect([...resolveNodeCommandAllowlist({}, node)]).toEqual(["system.notify", "computer.act"]);
  });

  it("does not allow connected node plugin tools without a registry default or config allowlist", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["remote.echo"],
    });

    expect(allowlist.has("remote.echo")).toBe(false);
    expect(
      isNodeCommandAllowed({
        command: "remote.echo",
        declaredCommands: ["remote.echo"],
        allowlist,
      }),
    ).toEqual({ ok: false, reason: "command not allowlisted" });
  });

  it("keeps defaults for first-party native platform labels with matching families", () => {
    const cfg = {} as OpenClawConfig;

    const iosAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "iOS 18.4.0",
      deviceFamily: "iPhone",
    });
    expect(iosAllowlist.has("device.info")).toBe(true);
    expect(iosAllowlist.has("photos.latest")).toBe(true);
    expect(iosAllowlist.has("watch.status")).toBe(true);
    expect(iosAllowlist.has("watch.notify")).toBe(true);
    expect(iosAllowlist.has("health.summary")).toBe(false);
    expect(iosAllowlist.has("system.run")).toBe(false);

    const ipadAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "iPadOS 18.4.0",
      deviceFamily: "iPad",
    });
    expect(ipadAllowlist.has("device.info")).toBe(true);
    expect(ipadAllowlist.has("motion.activity")).toBe(true);
    expect(ipadAllowlist.has("watch.status")).toBe(false);
    expect(ipadAllowlist.has("watch.notify")).toBe(false);
    expect(ipadAllowlist.has("system.run")).toBe(false);

    const macAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "macOS 15.5.0",
      deviceFamily: "Mac",
    });
    expect(macAllowlist.has("system.run")).toBe(false);
    expect(macAllowlist.has("system.which")).toBe(false);
    expect(macAllowlist.has("screen.snapshot")).toBe(false);

    const watchAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "watchOS 11.5.0",
      deviceFamily: "Apple Watch",
    });
    expect(watchAllowlist.has("device.info")).toBe(true);
    expect(watchAllowlist.has("device.status")).toBe(true);
    expect(watchAllowlist.has("system.notify")).toBe(true);
    expect(watchAllowlist.has("watch.status")).toBe(false);
    expect(watchAllowlist.has("watch.notify")).toBe(false);
    expect(watchAllowlist.has("camera.list")).toBe(false);
    expect(watchAllowlist.has("system.run")).toBe(false);
  });

  it("requires matching watchOS platform and device-family metadata", () => {
    const cfg = {} as OpenClawConfig;
    const mismatch = resolveNodeCommandAllowlist(cfg, {
      platform: "watchOS 11.5.0",
      deviceFamily: "iPhone",
    });
    expect(mismatch.has("device.info")).toBe(false);

    const familyOnly = resolveNodeCommandAllowlist(cfg, { deviceFamily: "Apple Watch" });
    expect(familyOnly.has("device.info")).toBe(true);
    expect(familyOnly.has("system.run")).toBe(false);
  });

  it("keeps approved host commands on live desktop node sessions", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      nodeId: "node-1",
      connId: "conn-1",
      platform: "linux",
      deviceFamily: "Linux",
      commands: ["browser.proxy", "browser.proxy.upload.v1", "system.run"],
    });

    expect(allowlist.has("browser.proxy")).toBe(true);
    expect(allowlist.has("browser.proxy.upload.v1")).toBe(true);
    expect(allowlist.has("system.run")).toBe(true);
  });

  it("uses the app-recommendation kill switch for gateway device.apps access", () => {
    const macNode = {
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["device.apps"],
    };
    expect(resolveNodeCommandAllowlist({} as OpenClawConfig, macNode).has("device.apps")).toBe(
      true,
    );
    expect(
      resolveNodeCommandAllowlist(
        { wizard: { appRecommendations: false } } as OpenClawConfig,
        macNode,
      ).has("device.apps"),
    ).toBe(false);
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
            commands: { allow: ["screen.record"] },
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

  it("keeps computer.act declarable through desktop pairing allowlists only", () => {
    for (const [platform, deviceFamily] of [
      ["macos", "Mac"],
      ["windows", "Windows"],
      ["linux", "Linux"],
    ]) {
      const pairing = resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
        platform,
        deviceFamily,
        commands: ["computer.act", "screen.snapshot"],
      });
      expect(pairing.has("computer.act")).toBe(true);
      expect(pairing.has("screen.snapshot")).toBe(true);
    }

    for (const [platform, deviceFamily] of [
      ["ios", "iPhone"],
      ["android", "Android"],
    ]) {
      const pairing = resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
        platform,
        deviceFamily,
        commands: ["computer.act"],
      });
      expect(pairing.has("computer.act")).toBe(false);
    }

    const windowsPairing = resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
      commands: ["screen.record"],
    });
    // Dangerous commands outside PLATFORM_DEFAULTS stay out of pairing too.
    expect(windowsPairing.has("screen.record")).toBe(false);
  });

  it("scopes a plugin dangerous flag to plugin surfaces, not core platform defaults", () => {
    // A bundled computer-use provider plugin registers computer.act as dangerous
    // so it needs a registered invoke policy. That flag must not revoke the core
    // desktop platform default, whose grant is node enablement plus pairing.
    const registry = createEmptyPluginRegistry();
    for (const command of ["computer.act", "cua.driver.reset"]) {
      registry.nodeHostCommands.push({
        pluginId: "cua-computer",
        pluginName: "CUA Computer",
        source: "/extensions/cua-computer/index.ts",
        rootDir: "/extensions/cua-computer",
        command: {
          command,
          cap: "computer",
          dangerous: true,
          agentTool: {
            name: command.replaceAll(".", "_"),
            description: "Computer surface",
            defaultPlatforms: ["windows"],
          },
          handle: async () => "{}",
        },
      });
      registry.nodeInvokePolicies.push({
        pluginId: "cua-computer",
        pluginName: "CUA Computer",
        source: "/extensions/cua-computer/index.ts",
        rootDir: "/extensions/cua-computer",
        pluginConfig: {},
        policy: {
          commands: [command],
          dangerous: true,
          handle: async (ctx) => await ctx.invokeNode(),
        },
      });
    }
    setActivePluginRegistry(registry);

    const node = {
      platform: "windows",
      deviceFamily: "Windows",
      commands: ["computer.act", "cua.driver.reset"],
      approvedCommands: ["computer.act", "cua.driver.reset"],
    };
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, node);
    expect(allowlist.has("computer.act")).toBe(true);
    expect(allowlist.has("cua.driver.reset")).toBe(false);
    expect(
      isNodeCommandAllowed({
        command: "computer.act",
        declaredCommands: node.commands,
        allowlist,
      }),
    ).toEqual({ ok: true });

    const opted = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: { commands: { allow: ["cua.driver.reset"] } },
        },
      } as OpenClawConfig,
      node,
    );
    expect(opted.has("cua.driver.reset")).toBe(true);
  });

  it("keeps policy-withheld declared commands unauthorized", () => {
    expect(
      resolveRequiredNodeCommandAuthority({
        nodeId: "node-1",
        requiredCommands: ["screen.snapshot", "computer.act"],
        declaredCommands: ["screen.snapshot", "computer.act"],
        effectiveCommands: [],
        withheldCommands: ["computer.act"],
        allowlist: new Set(["screen.snapshot", "computer.act"]),
      }),
    ).toEqual({
      command: "computer.act",
      state: "unauthorized",
      message: expect.stringContaining("gateway.nodes.commands.deny"),
    });
  });

  it("keeps mobile UI commands declarable only on Android pairing surfaces", () => {
    const freshSetup = {
      gateway: {
        nodes: { denyCommands: ["mobile.ui.observe", "mobile.ui.act"] },
      },
    } as OpenClawConfig;
    const androidPairing = resolveNodePairingCommandAllowlist(freshSetup, {
      platform: "android",
      deviceFamily: "Android",
      commands: ["mobile.ui.observe", "mobile.ui.act"],
    });
    expect(androidPairing.has("mobile.ui.observe")).toBe(true);
    expect(androidPairing.has("mobile.ui.act")).toBe(true);

    const iosPairing = resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
      platform: "ios",
      deviceFamily: "iPhone",
      commands: ["mobile.ui.observe", "mobile.ui.act"],
    });
    expect(iosPairing.has("mobile.ui.observe")).toBe(false);
    expect(iosPairing.has("mobile.ui.act")).toBe(false);
  });

  it("requires explicit gateway opt-in for iOS health summaries", () => {
    const node = {
      platform: "iOS 18.4.0",
      deviceFamily: "iPhone",
      commands: ["health.summary"],
    };
    expect(resolveNodeCommandAllowlist({} as OpenClawConfig, node).has("health.summary")).toBe(
      false,
    );

    const enabled = {
      gateway: { nodes: { commands: { allow: ["health.summary"] } } },
    } as OpenClawConfig;
    expect(resolveNodePairingCommandAllowlist(enabled, node).has("health.summary")).toBe(true);
    expect(resolveNodeCommandAllowlist(enabled, node).has("health.summary")).toBe(true);

    const denied = {
      gateway: {
        nodes: {
          commands: { allow: ["health.summary"], deny: ["health.summary"] },
        },
      },
    } as OpenClawConfig;
    expect(resolveNodeCommandAllowlist(denied, node).has("health.summary")).toBe(false);
  });

  it("reads foreground restriction metadata from plugin node policies", () => {
    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(false);

    installCanvasPluginDefaults();

    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(true);
    expect(isForegroundRestrictedPluginNodeCommand("system.run")).toBe(false);
  });
});
