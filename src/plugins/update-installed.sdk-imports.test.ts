import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withEnvAsync } from "../test-utils/env.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Published @openclaw/codex@2026.8.35 imports a subpath this host no longer exports.
it.each([
  { sdkImport: "openclaw/plugin-sdk/agent-harness-task-runtime", retained: false },
  { sdkImport: "openclaw/plugin-sdk/core", retained: true },
])(
  "retains an unavailable official target only when $sdkImport resolves",
  async ({ sdkImport, retained }) => {
    const root = fs.realpathSync(tempDirs.make("openclaw-stale-official-"));
    const installPath = path.join(root, "extensions", "codex");
    fs.mkdirSync(path.join(installPath, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "package.json"),
      JSON.stringify({
        name: "@openclaw/codex",
        version: "2026.8.35",
        type: "module",
        openclaw: { extensions: ["./dist/index.js"], compat: { pluginApi: ">=2026.8.35" } },
      }),
    );
    fs.writeFileSync(
      path.join(installPath, "dist", "index.js"),
      `import { x } from "${sdkImport}";\nexport default function register() { return x; }\n`,
    );
    const config: OpenClawConfig = {
      plugins: {
        entries: { codex: { enabled: true } },
        installs: {
          codex: {
            source: "npm",
            spec: "@openclaw/codex",
            installPath,
            version: "2026.8.35",
            resolvedName: "@openclaw/codex",
            resolvedVersion: "2026.8.35",
            resolvedSpec: "@openclaw/codex@2026.8.35",
          },
        },
      },
    };
    await withServer(
      (_request, response) => {
        response.writeHead(404);
        response.end("Fixture target is unavailable");
      },
      async (registry) => {
        const env = {
          HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          NPM_CONFIG_REGISTRY: registry,
          npm_config_registry: registry,
          NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
          NPM_CONFIG_USERCONFIG: path.join(root, "empty.npmrc"),
        };
        await withEnvAsync(env, async () => {
          const result = await updateNpmInstalledPlugins({
            config,
            pluginIds: ["codex"],
            syncOfficialPluginInstalls: true,
            retainOnUnavailable: true,
            versionBoundPluginIds: new Set(["codex"]),
            coreVersion: "2026.9.33",
            timeoutMs: 60_000,
          });
          expect(result.outcomes).toEqual([
            retained
              ? expect.objectContaining({
                  pluginId: "codex",
                  status: "unchanged",
                  code: "plugin-target-unavailable",
                })
              : {
                  pluginId: "codex",
                  status: "error",
                  message: expect.stringContaining(
                    `Cannot keep "codex" at @openclaw/codex@2026.8.35: it imports ${sdkImport}, which OpenClaw 2026.9.33 no longer exports`,
                  ),
                },
          ]);
          if (!retained) {
            expect(result.outcomes[0]?.message).toContain("openclaw plugins update codex");
          }
        });
      },
    );
  },
);
