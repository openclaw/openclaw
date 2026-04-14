import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../../test/helpers/temp-repo.js";

// Isolate the loader from the real repo layout: only consider the tmp root
// reachable via `opts.cwd`. The real moduleUrl-based resolution would otherwise
// walk up to the repo and pick up the real extensions/ tree.
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (opts: { cwd?: string; argv1?: string; moduleUrl?: string }) =>
    opts.cwd ?? null,
  resolveOpenClawPackageRoot: async (opts: { cwd?: string; argv1?: string; moduleUrl?: string }) =>
    opts.cwd ?? null,
}));

import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
  vi.restoreAllMocks();
});

function seedRoot(prefix: string): string {
  const root = makeTempRepoRoot(tempDirs, prefix);
  writeJsonFile(path.join(root, "package.json"), { name: "openclaw" });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return root;
}

function seedChannelPkg(
  pkgJsonPath: string,
  opts: { id: string; docsPath: string; label?: string; blurb?: string },
): void {
  writeJsonFile(pkgJsonPath, {
    name: `@openclaw/${opts.id}`,
    openclaw: {
      channel: {
        id: opts.id,
        label: opts.label ?? opts.id,
        docsPath: opts.docsPath,
        blurb: opts.blurb ?? "test blurb",
      },
    },
  });
}

describe("listBundledChannelCatalogEntries", () => {
  it("loads catalog from dist/extensions when source extensions/ is absent (published tarball layout)", () => {
    const root = seedRoot("bcr-published-");
    seedChannelPkg(path.join(root, "dist", "extensions", "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/channels/telegram",
      label: "Telegram",
    });

    const entries = listBundledChannelCatalogEntries();
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram).toBeDefined();
    expect(telegram?.channel.docsPath).toBe("/channels/telegram");
  });

  it("prefers dist-runtime/extensions over dist/extensions when both exist", () => {
    const root = seedRoot("bcr-runtime-");
    seedChannelPkg(path.join(root, "dist-runtime", "extensions", "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/runtime/telegram",
    });
    seedChannelPkg(path.join(root, "dist", "extensions", "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/dist/telegram",
    });

    const entries = listBundledChannelCatalogEntries();
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram?.channel.docsPath).toBe("/runtime/telegram");
  });

  it("prefers source extensions/ only when dist candidates are absent", () => {
    const root = seedRoot("bcr-source-");
    seedChannelPkg(path.join(root, "extensions", "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/src/telegram",
    });

    const entries = listBundledChannelCatalogEntries();
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram?.channel.docsPath).toBe("/src/telegram");
  });

  it("skips empty candidate dir and tries next candidate", () => {
    const root = seedRoot("bcr-empty-");
    // dist-runtime/extensions exists but has no plugin dirs → should fall through.
    fs.mkdirSync(path.join(root, "dist-runtime", "extensions"), { recursive: true });
    seedChannelPkg(path.join(root, "dist", "extensions", "telegram", "package.json"), {
      id: "telegram",
      docsPath: "/fallthrough/telegram",
    });

    const entries = listBundledChannelCatalogEntries();
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram?.channel.docsPath).toBe("/fallthrough/telegram");
  });

  it("falls back to dist/channel-catalog.json when no bundled extension dirs exist", () => {
    const root = seedRoot("bcr-fallback-");
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

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toContain("fallback-channel");
  });
});
