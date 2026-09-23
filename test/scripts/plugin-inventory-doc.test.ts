import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPluginInventoryCoverage,
  resolvePluginSurface,
} from "../../scripts/lib/plugin-inventory-doc.mts";
import {
  collectPluginSourceEntries,
  exportPluginInventory,
  resolvePluginStatus,
} from "../../scripts/lib/plugin-inventory.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

function createInventoryRepository() {
  const root = lifetime.createTempDir("plugin-inventory-");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Inventory Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        `core.hooksPath=${path.join(root, "no-hooks")}`,
        ...args,
      ],
      { env, encoding: "utf8" },
    ).trim();
  const write = (file: string, value: unknown) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--initial-branch=main");
  write("package.json", { files: ["!dist/extensions/external/**", "!dist/extensions/source/**"] });
  write("extensions/core/openclaw.plugin.json", {
    id: "core",
    channels: ["fixture"],
    contracts: { tools: {} },
  });
  write("extensions/core/package.json", { name: "@fixture/core", version: "1.0.0" });
  write("extensions/external/openclaw.plugin.json", { id: "external", providers: ["fixture"] });
  write("extensions/external/package.json", {
    name: "@fixture/external",
    openclaw: { install: { npmSpec: "@fixture/external" } },
  });
  write("extensions/source/openclaw.plugin.json", {});
  write("scripts/lib/official-external-channel-seed.json", { entries: [{ id: "docs-only" }] });
  return { root, git, write, commit, sha: commit() };
}

describe("committed plugin inventory", () => {
  it("shares docs classification, includes manifest-only plugins, and excludes docs seeds", () => {
    const { root, sha } = createInventoryRepository();
    const report = exportPluginInventory(root);
    expect(report.source).toMatchObject({ kind: "git-tree", commit: sha });
    expect(report.scope).toBe("source-manifests");
    expect(
      report.plugins.map(({ id, distribution, package: pkg }) => [id, distribution, pkg]),
    ).toEqual([
      ["core", "core", { name: "@fixture/core", version: "1.0.0" }],
      ["external", "external", { name: "@fixture/external", version: null }],
      ["source", "source", null],
    ]);
    expect(report.plugins[0]!.declaredSurfaces).toEqual({
      channels: ["fixture"],
      contracts: { tools: {} },
    });
    expect(
      collectPluginSourceEntries(root).map((entry) => [
        entry.id,
        resolvePluginStatus(entry, new Set(["external", "source"])),
      ]),
    ).toEqual(report.plugins.map(({ id, distribution }) => [id, distribution]));
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it("is independent of dirty, untracked, and absent working-tree metadata", () => {
    const { root, write, sha } = createInventoryRepository();
    const before = exportPluginInventory(root, sha);
    write("package.json", { files: [] });
    write("extensions/core/openclaw.plugin.json", { id: "changed" });
    write("extensions/untracked/openclaw.plugin.json", { id: "untracked" });
    fs.rmSync(path.join(root, "extensions/external"), { recursive: true });
    expect(exportPluginInventory(root, sha)).toEqual(before);
    expect(exportPluginInventory(root)).toEqual(before);
  });

  it("changes its digest with committed metadata and can reproduce an earlier commit", () => {
    const { root, write, commit, sha } = createInventoryRepository();
    const before = exportPluginInventory(root);
    write("extensions/core/openclaw.plugin.json", { id: "core", channels: ["changed"] });
    const next = commit();
    const after = exportPluginInventory(root);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.source.commit).toBe(next);
    expect(exportPluginInventory(root, sha)).toEqual(before);
    expect(exportPluginInventory(root)).toEqual(after);
  });

  it("rejects duplicate IDs, malformed JSON and unavailable or non-commit identities", () => {
    const { root, write, commit, git } = createInventoryRepository();
    expect(() => exportPluginInventory(root, "main")).toThrow("full lowercase commit SHA");
    expect(() => exportPluginInventory(root, "0".repeat(40))).toThrow();
    expect(() => exportPluginInventory(root, git("rev-parse", "HEAD^{tree}"))).toThrow();
    write("extensions/source/openclaw.plugin.json", { id: "core" });
    commit();
    expect(() => exportPluginInventory(root)).toThrow("duplicate manifest ids: core");
    fs.writeFileSync(path.join(root, "extensions/source/openclaw.plugin.json"), "{");
    commit();
    expect(() => exportPluginInventory(root)).toThrow(SyntaxError);
  });

  it("rejects non-regular metadata instead of following its working-tree target", () => {
    const { root, git } = createInventoryRepository();
    const oid = git("rev-parse", "HEAD:extensions/core/openclaw.plugin.json");
    git("update-index", "--cacheinfo", `120000,${oid},extensions/core/openclaw.plugin.json`);
    git("commit", "-qm", "non-regular metadata");
    expect(() => exportPluginInventory(root)).toThrow("regular Git blob");
  });

  it.each([
    ["--json", "--write"],
    ["--check", "--commit", "0".repeat(40)],
    ["--json", "--commit"],
    ["--json", "--unknown"],
    ["--json", "--commit", "0".repeat(40)],
  ])("fails without partial JSON for invalid export arguments %j", (...args) => {
    const { root } = createInventoryRepository();
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/generate-plugin-inventory-doc.mts"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[plugin-inventory] FAILED");
  });
});

describe("resolvePluginSurface", () => {
  it("keeps manifest identifiers as inline code while leaving labels visible", () => {
    expect(
      resolvePluginSurface({
        id: "example",
        channels: ["discord"],
        providers: ["openai"],
        contracts: {
          webSearchProviders: {},
          tools: {},
        },
        dashboard: {
          dataBindings: [{ id: "items.list" }],
          actionVerbs: [{ id: "refresh" }],
        },
        skills: ["example"],
      }),
    ).toEqual([
      "Channels: `discord`",
      "Providers: `openai`",
      "Contracts: `tools`, `webSearchProviders`",
      "Dashboard data bindings: `example.items.list`",
      "Dashboard action verbs: `example.refresh`",
      "Skills",
    ]);
  });

  it("returns no surface items when the manifest declares none", () => {
    // The generic fallback now lives in renderSurface(), which prints
    // "This plugin declares no channels, providers, commands, or contracts."
    // for an empty list. Keeping it out of the data layer lets the caller
    // choose its own wording.
    expect(resolvePluginSurface({})).toEqual([]);
  });

  it("renders root CLI commands separately from runtime slash command aliases", () => {
    expect(
      resolvePluginSurface({
        cliCommands: [
          { name: " voicecall " },
          { name: "browser" },
          { name: "voicecall" },
          { name: " " },
        ],
        commandAliases: [
          { name: "voice", kind: "runtime-slash" },
          { name: " voice ", kind: "runtime-slash" },
          { name: " ", kind: "runtime-slash" },
          { name: "internal", kind: "activation-only" },
        ],
      }),
    ).toEqual([
      "CLI commands: `openclaw browser`, `openclaw voicecall`",
      "Slash commands: `/voice`",
    ]);
  });

  it("escapes dashboard plugin owner delimiters and literal escape markers", () => {
    expect(
      resolvePluginSurface({
        id: "dashboard.segmented",
        dashboard: { actionVerbs: [{ id: "refresh" }] },
      }),
    ).toEqual(["Dashboard action verbs: `dashboard%2Esegmented.refresh`"]);
    expect(
      resolvePluginSurface({
        id: "dashboard%2Esegmented",
        dashboard: { dataBindings: [{ id: "refresh" }] },
      }),
    ).toEqual(["Dashboard data bindings: `dashboard%252Esegmented.refresh`"]);
  });
});

describe("assertPluginInventoryCoverage", () => {
  it("detects a manifest directory omitted from the collected source entries", () => {
    expect(() =>
      assertPluginInventoryCoverage(
        [{ dirName: "packaged", id: "packaged" }],
        [
          { dirName: "manifest-only", id: "manifest-only" },
          { dirName: "packaged", id: "packaged" },
        ],
      ),
    ).toThrow(/missing dirNames: manifest-only.*missing ids: manifest-only/u);
  });

  it("detects duplicate ids in the independent manifest enumeration", () => {
    const entries = [
      { dirName: "one", id: "duplicate" },
      { dirName: "two", id: "duplicate" },
    ];
    expect(() => assertPluginInventoryCoverage(entries, entries)).toThrow(
      "duplicate manifest ids: duplicate",
    );
  });
});
