// Bundled channel catalog read tests cover catalog loading from bundled channel metadata.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../../test/helpers/temp-repo.js";

// Delegate to the plugin-dir resolver for candidate-order policy; mock it here
// so these tests focus on the loader's responsibility (merge
// dist/channel-catalog.json entries with package.json metadata from the
// returned dir). The
// precedence policy (source vs dist-runtime vs dist, VITEST/tsx source-first,
// isSourceCheckoutRoot detection, etc.) is exercised in
// src/plugins/bundled-dir.test.ts and is intentionally not re-tested here.
vi.mock("../plugins/bundled-dir.js", () => ({
  resolveBundledPluginsDir: vi.fn(),
  resolveSourceCheckoutDependencyDiagnostic: vi.fn(() => null),
}));

vi.mock("../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: vi.fn(() => {
    throw new Error("bundled channel catalog read must not run full plugin discovery");
  }),
}));

// The channel-catalog.json fallback still walks package roots via
// resolveOpenClawPackageRootSync. Isolate from the real repo by mocking
// moduleUrl/argv1 resolution to null and deriving only from the tmp cwd.
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (opts: { cwd?: string; argv1?: string; moduleUrl?: string }) =>
    opts.cwd ?? null,
  resolveOpenClawPackageRoot: async (opts: { cwd?: string; argv1?: string; moduleUrl?: string }) =>
    opts.cwd ?? null,
}));

import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

afterEach(() => {
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPluginsDir;
  }
  cleanupTempDirs(tempDirs);
  vi.restoreAllMocks();
  vi.mocked(resolveBundledPluginsDir).mockReset();
});

function useBundledPluginsDir(extensionsRoot: string | undefined): void {
  if (extensionsRoot) {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = extensionsRoot;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  } else {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  }
  vi.mocked(resolveBundledPluginsDir).mockReturnValue(extensionsRoot);
}

function seedRoot(prefix: string): string {
  const root = makeTempRepoRoot(tempDirs, prefix);
  writeJsonFile(path.join(root, "package.json"), { name: "openclaw" });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return root;
}

function seedChannelPkg(
  pkgJsonPath: string,
  opts: {
    id: string;
    docsPath: string;
    label?: string;
    blurb?: string;
    markdownCapable?: boolean;
    approvalFlags?: readonly ["native"];
  },
): void {
  const pluginDir = path.dirname(pkgJsonPath);
  writeJsonFile(pkgJsonPath, {
    name: `@openclaw/${opts.id}`,
    openclaw: {
      channel: {
        id: opts.id,
        label: opts.label ?? opts.id,
        docsPath: opts.docsPath,
        blurb: opts.blurb ?? "test blurb",
        ...(opts.markdownCapable !== undefined ? { markdownCapable: opts.markdownCapable } : {}),
        ...(opts.approvalFlags ? { approvalFlags: opts.approvalFlags } : {}),
      },
    },
  });
  writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
    id: opts.id,
    configSchema: { type: "object" },
    channels: [opts.id],
  });
  fs.writeFileSync(path.join(pluginDir, "index.js"), "export default { register() {} };\n", "utf8");
}

describe("listBundledChannelCatalogEntries", () => {
  it("reads bundled channel metadata from the extensions dir returned by resolveBundledPluginsDir", () => {
    // Regression gate for the onboard crash on globally installed CLI: in a
    // published install, resolveBundledPluginsDir returns <pkgRoot>/dist/extensions.
    // Verify the loader iterates that tree and surfaces bundled channels such as
    // telegram, even when they are not in dist/channel-catalog.json.
    const root = seedRoot("bcr-resolved-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/channels/telegram",
      label: "Telegram",
      approvalFlags: ["native"],
    });
    seedChannelPkg(path.join(extensionsRoot, "imessage", "package.json"), {
      id: "imessage",
      docsPath: "/channels/imessage",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();

    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.has("imessage")).toBe(true);
    expect(ids.has("telegram")).toBe(true);
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram?.channel.docsPath).toBe("/channels/telegram");
    expect(telegram?.channel.label).toBe("Telegram");
    expect(telegram?.channel.approvalFlags).toEqual(["native"]);
  });

  it.each(["dist", "dist-runtime"])(
    "prefers source channel capabilities over a stale %s plugin runtime in a source checkout",
    (runtimeDirName) => {
      const root = seedRoot(`bcr-source-over-${runtimeDirName}-`);
      const sourceExtensionsRoot = path.join(root, "extensions");
      const runtimeExtensionsRoot = path.join(root, runtimeDirName, "extensions");
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf8");

      for (const id of ["slack", "signal", "whatsapp", "qqbot", "telegram", "discord"]) {
        seedChannelPkg(path.join(sourceExtensionsRoot, id, "package.json"), {
          id,
          docsPath: `/channels/${id}`,
          label: `source ${id}`,
          approvalFlags: ["native"],
        });
        seedChannelPkg(path.join(runtimeExtensionsRoot, id, "package.json"), {
          id,
          docsPath: `/channels/${id}`,
          label: `stale ${id}`,
          approvalFlags: id === "telegram" || id === "discord" ? ["native"] : undefined,
        });
      }
      seedChannelPkg(path.join(sourceExtensionsRoot, "line", "package.json"), {
        id: "line",
        docsPath: "/channels/line",
        label: "source line",
      });
      seedChannelPkg(path.join(runtimeExtensionsRoot, "line", "package.json"), {
        id: "line",
        docsPath: "/channels/line",
        label: "stale line",
        approvalFlags: ["native"],
      });
      useBundledPluginsDir(runtimeExtensionsRoot);

      const entries = listBundledChannelCatalogEntries();
      for (const id of ["slack", "signal", "whatsapp", "qqbot", "telegram", "discord"]) {
        const channel = entries.find((entry) => entry.id === id)?.channel;
        expect(channel?.approvalFlags, id).toEqual(["native"]);
        expect(channel?.label, id).toBe(`source ${id}`);
      }
      const line = entries.find((entry) => entry.id === "line")?.channel;
      expect(line?.label).toBe("source line");
      expect(line?.approvalFlags).toBeUndefined();
    },
  );

  it.each(["dist", "dist-runtime"])(
    "only exposes plugins present in a partially built %s runtime",
    (runtimeDirName) => {
      const root = seedRoot(`bcr-partial-${runtimeDirName}-`);
      const sourceExtensionsRoot = path.join(root, "extensions");
      const runtimeExtensionsRoot = path.join(root, runtimeDirName, "extensions");
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf8");

      seedChannelPkg(path.join(sourceExtensionsRoot, "slack", "package.json"), {
        id: "slack",
        docsPath: "/channels/slack",
        label: "source slack",
        approvalFlags: ["native"],
      });
      seedChannelPkg(path.join(runtimeExtensionsRoot, "slack", "package.json"), {
        id: "slack",
        docsPath: "/channels/slack",
        label: "stale runtime slack",
      });
      seedChannelPkg(path.join(sourceExtensionsRoot, "source-only", "package.json"), {
        id: "source-only",
        docsPath: "/channels/source-only",
      });
      seedChannelPkg(path.join(runtimeExtensionsRoot, "runtime-only", "package.json"), {
        id: "runtime-only",
        docsPath: "/channels/runtime-only",
        label: "runtime-only channel",
      });
      useBundledPluginsDir(runtimeExtensionsRoot);

      const entries = listBundledChannelCatalogEntries();

      expect(entries.map((entry) => entry.id).toSorted()).toEqual(["runtime-only", "slack"]);
      expect(entries.find((entry) => entry.id === "slack")?.channel).toMatchObject({
        label: "source slack",
        approvalFlags: ["native"],
      });
      expect(entries.find((entry) => entry.id === "runtime-only")?.channel.label).toBe(
        "runtime-only channel",
      );
    },
  );

  it("reads standalone source plugin manifests from the resolved source extensions directory", () => {
    const root = seedRoot("bcr-source-extensions-");
    const sourceExtensionsRoot = path.join(root, "extensions");
    seedChannelPkg(path.join(sourceExtensionsRoot, "slack", "package.json"), {
      id: "slack",
      docsPath: "/channels/slack",
      label: "standalone source slack",
      approvalFlags: ["native"],
    });
    useBundledPluginsDir(sourceExtensionsRoot);

    const slack = listBundledChannelCatalogEntries().find((entry) => entry.id === "slack");

    expect(slack?.channel.label).toBe("standalone source slack");
    expect(slack?.channel.approvalFlags).toEqual(["native"]);
  });

  it("preserves installed-runtime metadata when an extensions directory is not a source checkout", () => {
    const root = seedRoot("bcr-installed-runtime-wins-");
    const runtimeExtensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(root, "extensions", "slack", "package.json"), {
      id: "slack",
      docsPath: "/channels/slack",
      label: "untrusted source-shaped slack",
      approvalFlags: ["native"],
    });
    seedChannelPkg(path.join(runtimeExtensionsRoot, "slack", "package.json"), {
      id: "slack",
      docsPath: "/channels/slack",
      label: "installed runtime slack",
    });
    useBundledPluginsDir(runtimeExtensionsRoot);

    const slack = listBundledChannelCatalogEntries().find((entry) => entry.id === "slack");
    expect(slack?.channel.label).toBe("installed runtime slack");
    expect(slack?.channel.approvalFlags).toBeUndefined();
  });

  it("merges the generated official catalog with bundled package metadata", () => {
    const root = seedRoot("bcr-generated-official-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/channels/telegram",
      label: "Telegram",
    });
    writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
      entries: [
        {
          name: "@openclaw/qqbot",
          openclaw: {
            channel: {
              id: "qqbot",
              label: "QQ Bot",
              docsPath: "/channels/qqbot",
              blurb: "downloadable channel",
            },
          },
        },
      ],
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.has("qqbot")).toBe(true);
    expect(ids.has("telegram")).toBe(true);
  });

  it("keeps bundled package metadata when generated catalog entries are stale", () => {
    const root = seedRoot("bcr-package-wins-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "matrix", "package.json"), {
      id: "matrix",
      docsPath: "/channels/matrix",
      label: "Matrix",
      markdownCapable: true,
    });
    writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
      entries: [
        {
          name: "@openclaw/matrix",
          openclaw: {
            channel: {
              id: "matrix",
              label: "Matrix",
              docsPath: "/channels/matrix",
              blurb: "stale generated entry",
            },
          },
        },
      ],
    });
    useBundledPluginsDir(extensionsRoot);

    const matrix = listBundledChannelCatalogEntries().find((entry) => entry.id === "matrix");
    expect(matrix?.channel.markdownCapable).toBe(true);
  });

  it("falls back to dist/channel-catalog.json when the resolver returns undefined", () => {
    // OPENCLAW_DISABLE_BUNDLED_PLUGINS, missing bundled tree, or an unresolvable
    // package root all surface as undefined from resolveBundledPluginsDir. In
    // that case the loader should consult the shipped channel-catalog.json
    // rather than report zero bundled channels.
    const root = seedRoot("bcr-fallback-undefined-");
    writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
      entries: [
        {
          name: "@openclaw/fallback",
          openclaw: {
            channel: {
              id: "fallback-channel",
              label: "Fallback",
              docsPath: "/channels/fallback",
              blurb: "fallback blurb",
            },
          },
        },
      ],
    });
    useBundledPluginsDir(undefined);

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toContain("fallback-channel");
  });

  it("falls back to dist/channel-catalog.json when the resolved dir has no plugin package.jsons", () => {
    // A stale staged dir or an OPENCLAW_BUNDLED_PLUGINS_DIR override pointing at
    // an empty tree should not hide the shipped catalog entries. The loader's
    // own readdir returns nothing, bundledEntries is empty, and control falls
    // through to readOfficialCatalogFileSync.
    const root = seedRoot("bcr-fallback-empty-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    fs.mkdirSync(extensionsRoot, { recursive: true });
    writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
      entries: [
        {
          name: "@openclaw/fallback",
          openclaw: {
            channel: {
              id: "fallback-channel",
              label: "Fallback",
              docsPath: "/channels/fallback",
              blurb: "fallback blurb",
            },
          },
        },
      ],
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toContain("fallback-channel");
  });
});
