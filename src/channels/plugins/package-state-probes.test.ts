import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  collectBundledChannelPackageStateLoadFailures,
  hasBundledChannelPackageState,
  hasBundledChannelPackageStateAsync,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

const listChannelCatalogEntriesMock = vi.hoisted(() => vi.fn());
const isBundledSourceOverlayPathMock = vi.hoisted(() =>
  vi.fn((_params: { sourcePath: string }) => false),
);
const probeLogWarnMock = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));
vi.mock("../../plugins/bundled-source-overlays.js", () => ({
  isBundledSourceOverlayPath: isBundledSourceOverlayPathMock,
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: probeLogWarnMock,
    }),
  };
});

function makeBundledChannelCatalogEntry(
  pluginId: string,
  channelId: string,
): PluginChannelCatalogEntry {
  return {
    pluginId,
    origin: "bundled",
    rootDir: "/tmp/openclaw-channel-plugin",
    channel: {
      id: channelId,
      configuredState: { env: { allOf: ["ALIAS_CHAT_TOKEN"] } },
    },
  };
}

function tempRoot(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function registerModule(
  rootDir: string,
  channel: PluginChannelCatalogEntry["channel"] & { id: string },
) {
  listChannelCatalogEntriesMock.mockReturnValue([
    {
      pluginId: channel.id,
      origin: "bundled",
      rootDir,
      channel,
    } satisfies PluginChannelCatalogEntry,
  ]);
}

function probeState(
  channelId: string,
  env?: NodeJS.ProcessEnv,
  metadataKey: "configuredState" | "persistedAuthState" = "persistedAuthState",
) {
  return hasBundledChannelPackageState({ metadataKey, channelId, cfg: {}, env });
}

function removeTempDirs() {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  removeTempDirs();
  listChannelCatalogEntriesMock.mockReset();
  isBundledSourceOverlayPathMock.mockReset();
  isBundledSourceOverlayPathMock.mockReturnValue(false);
  probeLogWarnMock.mockReset();
});

afterEach(() => {
  removeTempDirs();
});

describe("channel package-state probes", () => {
  it("awaits the selected async checker and never retries a refusal through the sync checker", async () => {
    const root = tempRoot("openclaw-package-state-async-");
    fs.writeFileSync(
      path.join(root, "auth-presence.js"),
      [
        "module.exports.hasState = () => { throw new Error('sync checker must not run'); };",
        "module.exports.hasStateAsync = async ({ env }) => {",
        "  if (env.REFUSE) throw new Error('owner refused');",
        "  return env.HAS_STATE === 'yes';",
        "};",
      ].join("\n"),
    );
    registerModule(root, {
      id: "fixture",
      persistedAuthState: {
        specifier: "./auth-presence",
        exportName: "hasState",
        exportNameAsync: "hasStateAsync",
      },
    });
    const probe = (env: NodeJS.ProcessEnv) =>
      hasBundledChannelPackageStateAsync({
        metadataKey: "persistedAuthState",
        channelId: "fixture",
        cfg: {},
        env,
      });
    await expect(probe({ HAS_STATE: "yes" })).resolves.toBe(true);
    await expect(probe({ HAS_STATE: "no" })).resolves.toBe(false);
    await expect(probe({ REFUSE: "yes" })).rejects.toThrow("owner refused");
  });

  it("preserves checker loading and newly created plugin state", () => {
    const root = tempRoot("openclaw-presence-prerequisite-");
    const pluginRoot = path.join(root, "extensions", "fixture");
    const marker = path.join(root, "loaded");
    const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
    const database = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "auth-presence.js"),
      [
        `const fs = require("node:fs");`,
        `fs.writeFileSync(${JSON.stringify(marker)}, "loaded");`,
        `module.exports.hasState = () => fs.existsSync(${JSON.stringify(database)});`,
      ].join("\n"),
    );
    registerModule(pluginRoot, {
      id: "fixture",
      persistedAuthState: {
        specifier: "./auth-presence",
        exportName: "hasState",
        backingStore: "plugin-state",
      },
    });
    const probe = () => probeState("fixture", env);
    expect(probe()).toBe(false);
    expect(fs.existsSync(database)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.writeFileSync(database, "existing fixture; checker owns interpretation");
    expect(probe()).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("loaded");
  });

  it("uses channel ids when manifest plugin ids differ", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      makeBundledChannelCatalogEntry("vendor-alias-chat-plugin", "alias-chat"),
    ]);

    expect(listBundledChannelIdsForPackageState("configuredState")).toEqual(["alias-chat"]);
    const env = { ALIAS_CHAT_TOKEN: "token" };
    expect(probeState("alias-chat", env, "configuredState")).toBe(true);
    expect(probeState("vendor-alias-chat-plugin", env, "configuredState")).toBe(false);
  });

  it.each([
    { name: "PATH", env: { PATH: "/usr/bin" }, configured: false },
    { name: "mixed_case_token", env: { MIXED_CASE_TOKEN: "token" }, configured: true },
  ])("applies the safe channel env-trigger contract to $name", ({ name, env, configured }) => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        ...makeBundledChannelCatalogEntry("env-chat", "env-chat"),
        channel: { id: "env-chat", configuredState: { env: { allOf: [name] } } },
      } satisfies PluginChannelCatalogEntry,
    ]);

    expect(probeState("env-chat", env, "configuredState")).toBe(configured);
  });

  it("falls back to source package-state probes when built artifacts are stale", () => {
    const root = tempRoot("openclaw-package-state-fallback-");
    const sourceRoot = path.join(root, "extensions", "whatsapp");
    const builtRoot = path.join(root, "dist", "extensions", "whatsapp");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "auth-presence.js"),
      "module.exports.hasAnyWhatsAppAuth = () => true;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(builtRoot, "auth-presence.js"),
      "module.exports.stale = () => false;\n",
      "utf8",
    );

    registerModule(sourceRoot, {
      id: "whatsapp",
      persistedAuthState: { specifier: "./auth-presence", exportName: "hasAnyWhatsAppAuth" },
    });
    expect(probeState("whatsapp")).toBe(true);
  });

  it("preserves mtsx source overlay precedence over packaged package-state probes", () => {
    const root = tempRoot("openclaw-package-state-overlay-");
    const sourceRoot = path.join(root, "extensions", "matrix");
    const builtRoot = path.join(root, "dist", "extensions", "matrix");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "auth-presence.mtsx"),
      "export const hasAnyMatrixAuth = (): boolean => true;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(builtRoot, "auth-presence.js"),
      "module.exports.hasAnyMatrixAuth = () => false;\n",
      "utf8",
    );
    isBundledSourceOverlayPathMock.mockImplementation(
      ({ sourcePath }: { sourcePath: string }) => path.resolve(sourcePath) === sourceRoot,
    );

    const checker = { specifier: "./auth-presence.mtsx", exportName: "hasAnyMatrixAuth" };
    registerModule(sourceRoot, {
      id: "matrix",
      configuredState: checker,
      persistedAuthState: checker,
    });

    for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
      expect(probeState("matrix", undefined, metadataKey)).toBe(true);
    }
  });

  it("reports a missing built package-state artifact as not found, not a boundary escape", () => {
    // Reproduces a rebuild window: the catalog root is the built plugin dir while
    // `dist/extensions/<id>` has not been re-emitted yet.
    const root = tempRoot("openclaw-package-state-missing-");
    const builtRoot = path.join(root, "dist", "extensions", "matrix");
    fs.mkdirSync(builtRoot, { recursive: true });

    registerModule(builtRoot, {
      id: "matrix",
      persistedAuthState: { specifier: "./auth-presence", exportName: "hasAnyMatrixAuth" },
    });
    expect(probeState("matrix")).toBe(false);
    const warning = String(probeLogWarnMock.mock.calls.at(0)?.[0] ?? "");
    expect(warning).toContain("failed to load persistedAuthState checker for matrix");
    expect(warning).toContain(`plugin module path not found: ${builtRoot}`);
    expect(warning).not.toContain("escapes plugin root");
    expect(collectBundledChannelPackageStateLoadFailures()).toEqual([
      {
        detail: expect.stringContaining(`plugin module path not found: ${builtRoot}`),
        metadataKey: "persistedAuthState",
        pluginId: "matrix",
      },
    ]);
  });
});
