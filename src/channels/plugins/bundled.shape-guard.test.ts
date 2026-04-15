import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../plugins/bundled-channel-runtime.js");
  vi.doUnmock("../../plugins/bundled-plugin-metadata.js");
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
  vi.doUnmock("../../plugins/channel-catalog-registry.js");
  vi.doUnmock("../../infra/boundary-file-read.js");
  vi.doUnmock("jiti");
});

describe("bundled channel entry shape guards", () => {
  const bundledPluginRoots = loadPluginManifestRegistry({ cache: true, config: {} })
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => plugin.rootDir);

  it("treats missing bundled discovery results as empty", async () => {
    vi.doMock("../../plugins/bundled-channel-runtime.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/bundled-channel-runtime.js")>();
      return {
        ...actual,
        listBundledChannelPluginMetadata: () => [],
      };
    });

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=missing-bundled-discovery",
    );

    expect(bundled.listBundledChannelPlugins()).toEqual([]);
    expect(bundled.listBundledChannelSetupPlugins()).toEqual([]);
  });

  it("loads real bundled channel entries from the source tree", async () => {
    vi.doMock("../../plugins/bundled-channel-runtime.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/bundled-channel-runtime.js")>();
      return {
        ...actual,
        listBundledChannelPluginMetadata: (params: {
          includeChannelConfigs: boolean;
          includeSyntheticChannelConfigs: boolean;
        }) =>
          actual
            .listBundledChannelPluginMetadata(params)
            .filter(
              (metadata) => metadata.manifest.id === "slack" || metadata.manifest.id === "line",
            ),
      };
    });

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=real-bundled-source-tree",
    );

    expect(bundled.requireBundledChannelPlugin("slack").id).toBe("slack");
    expect(() =>
      bundled.setBundledChannelRuntime("line", {
        channel: {
          line: {
            listLineAccountIds: () => [],
            resolveDefaultLineAccountId: () => undefined,
            resolveLineAccount: () => null,
          },
        },
      } as never),
    ).not.toThrow();
  });

  it("keeps channel entrypoints on the dedicated entry-contract SDK surface", () => {
    const offenders: string[] = [];

    for (const extensionDir of bundledPluginRoots) {
      for (const relativePath of ["index.ts", "channel-entry.ts", "setup-entry.ts"]) {
        const filePath = path.join(extensionDir, relativePath);
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const source = fs.readFileSync(filePath, "utf8");
        const usesEntryHelpers =
          source.includes("defineBundledChannelEntry") ||
          source.includes("defineBundledChannelSetupEntry");
        if (!usesEntryHelpers) {
          continue;
        }
        if (
          !source.includes('from "openclaw/plugin-sdk/channel-entry-contract"') ||
          source.includes('from "openclaw/plugin-sdk/core"') ||
          source.includes('from "openclaw/plugin-sdk/channel-core"')
        ) {
          offenders.push(path.relative(process.cwd(), filePath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps bundled channel entrypoints free of static src imports", () => {
    const offenders: string[] = [];

    for (const extensionDir of bundledPluginRoots) {
      for (const relativePath of ["index.ts", "channel-entry.ts", "setup-entry.ts"]) {
        const filePath = path.join(extensionDir, relativePath);
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const source = fs.readFileSync(filePath, "utf8");
        const usesEntryHelpers =
          source.includes("defineBundledChannelEntry") ||
          source.includes("defineBundledChannelSetupEntry");
        if (!usesEntryHelpers) {
          continue;
        }
        if (/^(?:import|export)\s.+["']\.\/src\//mu.test(source)) {
          offenders.push(path.relative(process.cwd(), filePath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps channel implementations off the broad core SDK surface", () => {
    const offenders: string[] = [];

    for (const extensionDir of bundledPluginRoots) {
      for (const relativePath of ["src/channel.ts", "src/plugin.ts"]) {
        const filePath = path.join(extensionDir, relativePath);
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const source = fs.readFileSync(filePath, "utf8");
        if (!source.includes("createChatChannelPlugin")) {
          continue;
        }
        if (source.includes('from "openclaw/plugin-sdk/core"')) {
          offenders.push(path.relative(process.cwd(), filePath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps plugin-sdk channel-core free of chat metadata bootstrap imports", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/channel-core.ts"), "utf8");

    expect(source.includes("../channels/chat-meta.js")).toBe(false);
    expect(source.includes("getChatChannelMeta")).toBe(false);
  });

  it("keeps bundled hot runtime barrels off the broad core SDK surface", () => {
    const offenders = [
      "extensions/googlechat/runtime-api.ts",
      "extensions/irc/src/runtime-api.ts",
      "extensions/matrix/src/runtime-api.ts",
    ].filter((filePath) =>
      fs.readFileSync(path.resolve(filePath), "utf8").includes("openclaw/plugin-sdk/core"),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps runtime helper surfaces off bootstrap-registry", () => {
    const offenders = [
      "src/config/markdown-tables.ts",
      "src/config/sessions/group.ts",
      "src/channels/plugins/setup-helpers.ts",
      "src/plugin-sdk/extension-shared.ts",
    ].filter((filePath) =>
      fs.readFileSync(path.resolve(filePath), "utf8").includes("bootstrap-registry.js"),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps extension-shared off the broad runtime barrel", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/extension-shared.ts"), "utf8");

    expect(source.includes('from "./runtime.js"')).toBe(false);
  });

  it("keeps nextcloud-talk's private SDK surface off the broad runtime barrel", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/nextcloud-talk.ts"), "utf8");

    expect(source.includes('from "./runtime.js"')).toBe(false);
  });

  it("keeps bundled doctor surfaces off the broad runtime barrel", () => {
    const offenders = [
      "extensions/discord/src/doctor.ts",
      "extensions/matrix/src/doctor.ts",
      "extensions/slack/src/doctor.ts",
      "extensions/telegram/src/doctor.ts",
      "extensions/zalouser/src/doctor.ts",
    ].filter((filePath) =>
      fs
        .readFileSync(path.resolve(filePath), "utf8")
        .includes('from "openclaw/plugin-sdk/runtime"'),
    );

    expect(offenders).toEqual([]);
  });

  it("breaks reentrant bundled channel discovery cycles with an empty fallback", async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-reentrant-"));
    const modulePath = path.join(pluginDir, "index.js");
    fs.writeFileSync(modulePath, "export {};\n", "utf8");

    vi.doMock("../../plugins/bundled-plugin-metadata.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/bundled-plugin-metadata.js")>();
      return {
        ...actual,
        listBundledPluginMetadata: () => [
          {
            dirName: "alpha",
            idHint: "alpha",
            source: {
              source: "./index.js",
              built: "./index.js",
            },
            manifest: {
              id: "alpha",
              channels: ["alpha"],
            },
          },
        ],
        resolveBundledPluginGeneratedPath: () => modulePath,
      };
    });
    vi.doMock("../../infra/boundary-file-read.js", () => ({
      openBoundaryFileSync: ({ absolutePath }: { absolutePath: string }) => ({
        ok: true,
        path: absolutePath,
        fd: fs.openSync(absolutePath, "r"),
      }),
    }));
    vi.doMock("../../plugins/channel-catalog-registry.js", () => ({
      listChannelCatalogEntries: () => [],
    }));

    let reentered = false;
    vi.doMock("jiti", () => ({
      createJiti: () => {
        return () => {
          if (!reentered) {
            reentered = true;
            expect(bundled.listBundledChannelPlugins()).toEqual([]);
          }
          return {
            default: {
              kind: "bundled-channel-entry",
              id: "alpha",
              name: "Alpha",
              description: "Alpha",
              configSchema: {},
              register() {},
              loadChannelPlugin() {
                return {
                  id: "alpha",
                  meta: {},
                  capabilities: {},
                  config: {},
                };
              },
            },
          };
        };
      },
    }));

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=reentrant-bundled-discovery",
    );

    expect(bundled.listBundledChannelPlugins()).toHaveLength(1);
    expect(reentered).toBe(true);
  });

  it("keeps private src runtime barrels from forwarding to parent runtime barrels that export local plugins", () => {
    const offenders: string[] = [];

    for (const extensionDir of bundledPluginRoots) {
      const privateRuntimePath = path.join(extensionDir, "src", "runtime-api.ts");
      const publicRuntimePath = path.join(extensionDir, "runtime-api.ts");
      if (!fs.existsSync(privateRuntimePath) || !fs.existsSync(publicRuntimePath)) {
        continue;
      }
      const privateRuntimeSource = fs.readFileSync(privateRuntimePath, "utf8");
      const publicRuntimeSource = fs.readFileSync(publicRuntimePath, "utf8");
      const forwardsParentRuntime =
        privateRuntimeSource.includes('export * from "../runtime-api.js"') ||
        privateRuntimeSource.includes("export * from '../runtime-api.js'");
      const exportsLocalPlugin =
        publicRuntimeSource.includes('from "./src/channel.js"') &&
        /export\s+\{\s*[\w$]+Plugin\s*\}\s+from\s+["']\.\/src\/channel\.js["']/u.test(
          publicRuntimeSource,
        );
      if (forwardsParentRuntime && exportsLocalPlugin) {
        offenders.push(path.relative(process.cwd(), publicRuntimePath));
      }
    }

    expect(offenders).toEqual([]);
  });
});
