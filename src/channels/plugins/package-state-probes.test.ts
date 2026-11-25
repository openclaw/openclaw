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
let root: string;

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

function writeProbe(directory: string, source: string, filename = "auth-presence.js") {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), source, "utf8");
}

function registerModule(
  rootDir: string,
  channel: PluginChannelCatalogEntry["channel"] & { id: string },
  pluginId = channel.id,
) {
  listChannelCatalogEntriesMock.mockReturnValue([
    { pluginId, origin: "bundled", rootDir, channel } satisfies PluginChannelCatalogEntry,
  ]);
}

function registerProbe(
  rootDir: string,
  id: string,
  checker: Partial<NonNullable<PluginChannelCatalogEntry["channel"]["persistedAuthState"]>> = {},
) {
  registerModule(rootDir, {
    id,
    persistedAuthState: { specifier: "./auth-presence", exportName: "hasState", ...checker },
  });
}

function probeState(
  channelId: string,
  env?: NodeJS.ProcessEnv,
  metadataKey: "configuredState" | "persistedAuthState" = "persistedAuthState",
) {
  return hasBundledChannelPackageState({ metadataKey, channelId, cfg: {}, env });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-state-"));
  listChannelCatalogEntriesMock.mockReset();
  isBundledSourceOverlayPathMock.mockReset();
  isBundledSourceOverlayPathMock.mockReturnValue(false);
  probeLogWarnMock.mockReset();
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("channel package-state probes", () => {
  it("awaits the selected async checker and never retries a refusal through the sync checker", async () => {
    writeProbe(
      root,
      `module.exports.hasState = () => { throw new Error('sync checker must not run'); };
module.exports.hasStateAsync = async ({ env }) => {
  if (env.REFUSE) throw new Error('owner refused');
  return env.HAS_STATE === 'yes';
};`,
    );
    registerProbe(root, "fixture", { exportNameAsync: "hasStateAsync" });
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
    const pluginRoot = path.join(root, "extensions", "fixture");
    const marker = path.join(root, "loaded");
    const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
    const database = resolveOpenClawStateSqlitePath(env);
    writeProbe(
      pluginRoot,
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(marker)}, "loaded");
module.exports.hasState = () => fs.existsSync(${JSON.stringify(database)});`,
    );
    registerProbe(pluginRoot, "fixture", { backingStore: "plugin-state" });
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
    registerModule(
      "/tmp/openclaw-channel-plugin",
      {
        id: "alias-chat",
        configuredState: { env: { allOf: ["ALIAS_CHAT_TOKEN"] } },
      },
      "vendor-alias-chat-plugin",
    );

    expect(listBundledChannelIdsForPackageState("configuredState")).toEqual(["alias-chat"]);
    const env = { ALIAS_CHAT_TOKEN: "token" };
    expect(probeState("alias-chat", env, "configuredState")).toBe(true);
    expect(probeState("vendor-alias-chat-plugin", env, "configuredState")).toBe(false);
  });

  it.each([
    { name: "PATH", env: { PATH: "/usr/bin" }, configured: false },
    { name: "mixed_case_token", env: { MIXED_CASE_TOKEN: "token" }, configured: true },
  ])("applies the safe channel env-trigger contract to $name", ({ name, env, configured }) => {
    registerModule("/tmp/openclaw-channel-plugin", {
      id: "env-chat",
      configuredState: { env: { allOf: [name] } },
    });

    expect(probeState("env-chat", env, "configuredState")).toBe(configured);
  });

  it.each([false, true])(
    "uses source probes with overlay=%s or stale built artifacts",
    (overlay) => {
      const sourceRoot = path.join(root, "extensions", "fixture");
      const builtRoot = path.join(root, "dist", "extensions", "fixture");
      const filename = overlay ? "auth-presence.mtsx" : "auth-presence.js";
      writeProbe(
        sourceRoot,
        overlay
          ? "export const hasState = (): boolean => true;"
          : "module.exports.hasState = () => true;",
        filename,
      );
      writeProbe(
        builtRoot,
        overlay ? "module.exports.hasState = () => false;" : "module.exports.stale = () => false;",
      );
      isBundledSourceOverlayPathMock.mockImplementation(
        ({ sourcePath }: { sourcePath: string }) =>
          overlay && path.resolve(sourcePath) === sourceRoot,
      );
      const checker = {
        specifier: overlay ? `./${filename}` : "./auth-presence",
        exportName: "hasState",
      };
      registerModule(sourceRoot, {
        id: "fixture",
        configuredState: checker,
        persistedAuthState: checker,
      });
      for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
        expect(probeState("fixture", undefined, metadataKey)).toBe(true);
      }
    },
  );

  it("reports a missing built package-state artifact as not found, not a boundary escape", () => {
    // The catalog can retain a built root while a rebuild has temporarily removed its artifacts.
    const builtRoot = path.join(root, "dist", "extensions", "matrix");
    fs.mkdirSync(builtRoot, { recursive: true });

    registerProbe(builtRoot, "matrix", { exportName: "hasAnyMatrixAuth" });
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
