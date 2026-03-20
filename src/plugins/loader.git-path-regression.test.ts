import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { __testing } from "./loader.js";

const EMPTY_PLUGIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const tempRoots: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-loader-"));
  tempRoots.push(dir);
  return dir;
}

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadOpenClawPlugins", () => {
  it("builds plugin-loader aliases for git-style package extension entries that import plugin-sdk channel-runtime (#49806)", () => {
    const pluginId = "imessage-loader-regression";
    const gitExtensionRoot = path.join(
      makeTempDir(),
      "git-source-checkout",
      "extensions",
      pluginId,
    );
    const gitSourceDir = path.join(gitExtensionRoot, "src");
    mkdirSafe(gitSourceDir);

    fs.writeFileSync(
      path.join(gitExtensionRoot, "package.json"),
      JSON.stringify(
        {
          name: `@openclaw/${pluginId}`,
          version: "0.0.1",
          type: "module",
          openclaw: {
            extensions: ["./src/index.ts"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(gitExtensionRoot, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: pluginId,
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(gitSourceDir, "channel.runtime.ts"),
      `import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-runtime";

export function runtimeProbeType() {
  return typeof resolveOutboundSendDep;
}
`,
      "utf-8",
    );
    const entryFile = path.join(gitSourceDir, "index.ts");
    fs.writeFileSync(
      entryFile,
      `import { runtimeProbeType } from "./channel.runtime.ts";

export default {
  id: ${JSON.stringify(pluginId)},
  register() {
    if (runtimeProbeType() !== "function") {
      throw new Error("channel-runtime import did not resolve");
    }
  },
};
`,
      "utf-8",
    );

    const { aliasMap, runtimeModulePath, tryNative } = withEnv(
      {
        NODE_ENV: "production",
        VITEST: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
      () => ({
        aliasMap: __testing.buildPluginLoaderAliasMap(entryFile),
        runtimeModulePath: __testing.resolvePluginRuntimeModulePath({ modulePath: entryFile }),
        tryNative: __testing.shouldPreferNativeJiti(entryFile),
      }),
    );

    expect(tryNative).toBe(false);
    expect(aliasMap).toHaveProperty("openclaw/plugin-sdk");
    expect(aliasMap["openclaw/plugin-sdk"]).toMatch(/plugin-sdk[\\/]root-alias\.cjs$/);
    expect(aliasMap["openclaw/plugin-sdk/channel-runtime"]).toMatch(
      /plugin-sdk[\\/](channel-runtime\.ts|channel-runtime\.js)$/,
    );
    expect(runtimeModulePath).toMatch(/plugins[\\/]runtime[\\/]index\.(ts|js)$/);
  });
});
