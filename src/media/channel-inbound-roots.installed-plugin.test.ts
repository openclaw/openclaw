// Channel inbound root installed-plugin tests cover external channel media contracts.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withEnv } from "../test-utils/env.js";
import {
  resolveChannelInboundAttachmentRootsForChannel,
  resolveChannelRemoteInboundAttachmentRoots,
} from "./channel-inbound-roots.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  setCurrentPluginMetadataSnapshot(undefined);
  clearPluginMetadataLifecycleCaches();
  tempDirs.cleanup();
});

function createContext(provider: string, accountId = "work"): MsgContext {
  return {
    Body: "hi",
    From: "imessage:work:demo",
    To: "+2000",
    ChatType: "direct",
    Provider: provider,
    AccountId: accountId,
  };
}

/** Writes an installed channel plugin whose media contract artifact exists on disk. */
function writeInstalledChannelPlugin(params: {
  pluginRoot: string;
  pluginId: string;
  marker: string;
}): string {
  const pluginDir = path.join(params.pluginRoot, params.pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), '{"type":"commonjs"}\n');
  fs.writeFileSync(
    path.join(pluginDir, "media-contract-api.js"),
    [
      `module.exports.resolveInboundAttachmentRoots = () => [${JSON.stringify(params.marker)} + "/local"];`,
      `module.exports.resolveRemoteInboundAttachmentRoots = () => [${JSON.stringify(params.marker)} + "/remote"];`,
      "",
    ].join("\n"),
  );
  return pluginDir;
}

/** Runs one installed-plugin scenario against an empty bundled plugin root. */
function withInstalledChannelPlugin(
  params: {
    cfg: OpenClawConfig;
    pluginDir: string;
    trustedOfficialInstall?: boolean;
  },
  run: () => void,
): void {
  const bundledPluginsDir = tempDirs.make("openclaw-media-bundled-");
  withEnv(
    {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    () => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "imessage",
            origin: "global",
            channels: ["imessage"],
            ...(params.trustedOfficialInstall === false ? {} : { trustedOfficialInstall: true }),
            rootDir: params.pluginDir,
          },
        ],
      });
      snapshot.policyHash = resolveInstalledPluginIndexPolicyHash(params.cfg);
      setCurrentPluginMetadataSnapshot(snapshot, { config: params.cfg });
      run();
    },
  );
}

describe("channel media contract resolution for installed plugins", () => {
  it("resolves local and remote media roots from a trusted installed channel plugin", () => {
    const pluginRoot = tempDirs.make("openclaw-media-installed-");
    const pluginDir = writeInstalledChannelPlugin({
      pluginRoot,
      pluginId: "imessage",
      marker: "/installed",
    });
    const cfg = { channels: { imessage: { enabled: true } } } as OpenClawConfig;

    withInstalledChannelPlugin({ cfg, pluginDir }, () => {
      expect(
        resolveChannelRemoteInboundAttachmentRoots({ cfg, ctx: createContext("imessage") }),
      ).toEqual(["/installed/remote"]);
      expect(
        resolveChannelInboundAttachmentRootsForChannel({
          cfg,
          channelId: "imessage",
          accountId: "work",
        }),
      ).toEqual(["/installed/local"]);
    });
  });

  it("ignores installed channel-adjacent plugins that are not trusted official installs", () => {
    const pluginRoot = tempDirs.make("openclaw-media-installed-");
    const pluginDir = writeInstalledChannelPlugin({
      pluginRoot,
      pluginId: "imessage",
      marker: "/untrusted",
    });
    const cfg = { channels: { imessage: { enabled: true } } } as OpenClawConfig;

    withInstalledChannelPlugin({ cfg, pluginDir, trustedOfficialInstall: false }, () => {
      expect(
        resolveChannelRemoteInboundAttachmentRoots({ cfg, ctx: createContext("imessage") }),
      ).toBeUndefined();
    });
  });

  it.each([
    ["denylisted", { plugins: { deny: ["imessage"] } }],
    ["explicitly disabled", { plugins: { entries: { imessage: { enabled: false } } } }],
    ["outside a restrictive allowlist", { plugins: { allow: ["localchat"] } }],
    ["with plugins globally disabled", { plugins: { enabled: false } }],
  ] as const)(
    "revokes attachment-root authority for an installed owner that is %s",
    (_label, pluginConfig) => {
      const pluginRoot = tempDirs.make("openclaw-media-installed-");
      const pluginDir = writeInstalledChannelPlugin({
        pluginRoot,
        pluginId: "imessage",
        marker: "/disabled",
      });
      const cfg = {
        channels: { imessage: { enabled: true } },
        ...pluginConfig,
      } as OpenClawConfig;

      withInstalledChannelPlugin({ cfg, pluginDir }, () => {
        expect(
          resolveChannelRemoteInboundAttachmentRoots({ cfg, ctx: createContext("imessage") }),
        ).toBeUndefined();
        expect(
          resolveChannelInboundAttachmentRootsForChannel({
            cfg,
            channelId: "imessage",
            accountId: "work",
          }),
        ).toBeUndefined();
      });
    },
  );

  it("revokes attachment-root authority after an earlier successful resolution", () => {
    const pluginRoot = tempDirs.make("openclaw-media-installed-");
    const pluginDir = writeInstalledChannelPlugin({
      pluginRoot,
      pluginId: "imessage",
      marker: "/policy-reload",
    });
    const enabledCfg = { channels: { imessage: { enabled: true } } } as OpenClawConfig;

    withInstalledChannelPlugin({ cfg: enabledCfg, pluginDir }, () => {
      expect(
        resolveChannelRemoteInboundAttachmentRoots({
          cfg: enabledCfg,
          ctx: createContext("imessage"),
        }),
      ).toEqual(["/policy-reload/remote"]);

      clearPluginMetadataLifecycleCaches();
      const deniedCfg = {
        channels: { imessage: { enabled: true } },
        plugins: { deny: ["imessage"] },
      } as OpenClawConfig;
      withInstalledChannelPlugin({ cfg: deniedCfg, pluginDir }, () => {
        expect(
          resolveChannelRemoteInboundAttachmentRoots({
            cfg: deniedCfg,
            ctx: createContext("imessage"),
          }),
        ).toBeUndefined();
        expect(
          resolveChannelInboundAttachmentRootsForChannel({
            cfg: deniedCfg,
            channelId: "imessage",
            accountId: "work",
          }),
        ).toBeUndefined();
      });
    });
  });

  it("keeps bundled channel media contracts ahead of installed plugin owners", () => {
    const pluginRoot = tempDirs.make("openclaw-media-installed-");
    const pluginDir = writeInstalledChannelPlugin({
      pluginRoot,
      pluginId: "imessage",
      marker: "/installed",
    });
    const bundledPluginsDir = tempDirs.make("openclaw-media-bundled-");
    const bundledChannelDir = path.join(bundledPluginsDir, "imessage");
    fs.mkdirSync(bundledChannelDir, { recursive: true });
    fs.writeFileSync(path.join(bundledChannelDir, "package.json"), '{"type":"commonjs"}\n');
    fs.writeFileSync(
      path.join(bundledChannelDir, "media-contract-api.js"),
      'module.exports.resolveRemoteInboundAttachmentRoots = () => ["/bundled/remote"];\n',
    );
    const cfg = { channels: { imessage: { enabled: true } } } as OpenClawConfig;

    withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () => {
        const snapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "imessage",
              origin: "global",
              channels: ["imessage"],
              trustedOfficialInstall: true,
              rootDir: pluginDir,
            },
          ],
        });
        snapshot.policyHash = resolveInstalledPluginIndexPolicyHash(cfg);
        setCurrentPluginMetadataSnapshot(snapshot, { config: cfg });

        expect(
          resolveChannelRemoteInboundAttachmentRoots({ cfg, ctx: createContext("imessage") }),
        ).toEqual(["/bundled/remote"]);
      },
    );
  });
});
