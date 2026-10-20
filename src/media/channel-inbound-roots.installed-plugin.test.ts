import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  resolveChannelInboundAttachmentRootsForChannel,
  resolveChannelRemoteInboundAttachmentRoots,
} from "./channel-inbound-roots.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const enabledCfg: OpenClawConfig = { channels: { imessage: { enabled: true } } };
const ctx: MsgContext = {
  Provider: "imessage",
  AccountId: "work",
};
let pluginDir: string;
let bundledPluginsDir: string;

function writePlugin(root: string, marker: string): string {
  const dir = path.join(root, "imessage");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}\n');
  fs.writeFileSync(
    path.join(dir, "media-contract-api.js"),
    `module.exports.resolveInboundAttachmentRoots = () => [${JSON.stringify(`${marker}/local`)}];\n` +
      `module.exports.resolveRemoteInboundAttachmentRoots = () => [${JSON.stringify(`${marker}/remote`)}];\n`,
  );
  return dir;
}

function installSnapshot(cfg = enabledCfg, trustedOfficialInstall = true) {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "imessage",
        origin: "global",
        channels: ["imessage"],
        ...(trustedOfficialInstall ? { trustedOfficialInstall: true } : {}),
        rootDir: pluginDir,
      },
    ],
  });
  snapshot.policyHash = resolveInstalledPluginIndexPolicyHash(cfg);
  setCurrentPluginMetadataSnapshot(snapshot, { config: cfg });
}

function resolveRoots(cfg: OpenClawConfig) {
  return {
    remote: resolveChannelRemoteInboundAttachmentRoots({ cfg, ctx }),
    local: resolveChannelInboundAttachmentRootsForChannel({
      cfg,
      channelId: "imessage",
      accountId: "work",
    }),
  };
}

beforeEach(() => {
  pluginDir = writePlugin(tempDirs.make("openclaw-media-installed-"), "/installed");
  bundledPluginsDir = tempDirs.make("openclaw-media-bundled-");
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
});

afterEach(() => {
  setCurrentPluginMetadataSnapshot(undefined);
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
});

describe("channel media contract resolution for installed plugins", () => {
  it("ignores installed channel-adjacent plugins that are not trusted official installs", () => {
    installSnapshot(enabledCfg, false);
    expect(resolveChannelRemoteInboundAttachmentRoots({ cfg: enabledCfg, ctx })).toBeUndefined();
  });

  it("resolves trusted installed roots and revokes them after a policy reload", () => {
    installSnapshot();
    expect(resolveRoots(enabledCfg)).toEqual({
      remote: ["/installed/remote"],
      local: ["/installed/local"],
    });
    clearPluginMetadataLifecycleCaches();
    const deniedCfg: OpenClawConfig = { ...enabledCfg, plugins: { deny: ["imessage"] } };
    installSnapshot(deniedCfg);
    expect(resolveRoots(deniedCfg)).toEqual({ remote: undefined, local: undefined });
  });

  it("revokes attachment-root authority when plugins are globally disabled", () => {
    const cfg: OpenClawConfig = { ...enabledCfg, plugins: { enabled: false } };
    installSnapshot(cfg);
    expect(resolveRoots(cfg)).toEqual({ remote: undefined, local: undefined });
  });

  it("keeps bundled channel media contracts ahead of installed plugin owners", () => {
    writePlugin(bundledPluginsDir, "/bundled");
    installSnapshot();
    expect(resolveChannelRemoteInboundAttachmentRoots({ cfg: enabledCfg, ctx })).toEqual([
      "/bundled/remote",
    ]);
  });
});
