import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import * as doc from "../../scripts/lib/plugin-inventory-doc.mts";
import * as inventory from "../../scripts/lib/plugin-inventory.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

function createInventoryRepository() {
  const root = lifetime.createTempDir("plugin-inventory-");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const gitOptions = [
    "commit.gpgSign=false",
    "user.name=Inventory Fixture",
    "user.email=fixture@example.invalid",
    `core.hooksPath=${path.join(root, "no-hooks")}`,
  ].flatMap((setting) => ["-c", setting]);
  const git = (...args: string[]) =>
    execFileSync("git", [...gitOptions, ...args], { cwd: root, env, encoding: "utf8" }).trim();
  const write = (file: string, value: unknown) => writeJsonFile(path.join(root, file), value);
  const manifest = (dir: string, value: unknown) =>
    write(`extensions/${dir}/openclaw.plugin.json`, value);
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--initial-branch=main");
  write("package.json", { files: ["!dist/extensions/external/**", "!dist/extensions/source/**"] });
  manifest("core", { id: "core", channels: ["fixture"], contracts: { tools: {} } });
  write("extensions/core/package.json", { name: "@fixture/core", version: "1.0.0" });
  manifest("external", { id: "external", providers: ["fixture"] });
  write("extensions/external/package.json", {
    name: "@fixture/external",
    openclaw: { install: { npmSpec: "@fixture/external" } },
  });
  manifest("source", {});
  write("scripts/lib/official-external-channel-seed.json", { entries: [{ id: "docs-only" }] });
  const read = (sha?: string) => inventory.exportPluginInventory(root, sha);
  return { root, git, write, manifest, commit, read, sha: commit() };
}

it("exports committed manifest inventory and excludes docs seeds", () => {
  const { root, sha, read } = createInventoryRepository();
  const report = read();
  const { plugins } = report;
  expect(report.source).toMatchObject({ kind: "git-tree", commit: sha });
  expect(report.scope).toBe("source-manifests");
  expect(plugins.map(({ id, distribution, package: pkg }) => [id, distribution, pkg])).toEqual([
    ["core", "core", { name: "@fixture/core", version: "1.0.0" }],
    ["external", "external", { name: "@fixture/external", version: null }],
    ["source", "source", null],
  ]);
  expect(plugins[0]!.declaredSurfaces).toEqual({ channels: ["fixture"], contracts: { tools: {} } });
  expect(inventory.collectPluginSourceEntries(root).map(({ id }) => id)).toEqual([
    "core",
    "external",
    "source",
  ]);
  expect(JSON.stringify(report)).not.toContain(root);
});

it("is independent of dirty, untracked, and absent working-tree metadata", () => {
  const { root, write, manifest, sha, read } = createInventoryRepository();
  const before = read(sha);
  write("package.json", { files: [] });
  manifest("core", { id: "changed" });
  manifest("untracked", { id: "untracked" });
  fs.rmSync(path.join(root, "extensions/external"), { recursive: true });
  expect(read(sha)).toEqual(before);
  expect(read()).toEqual(before);
});

it("changes its digest with committed metadata and can reproduce an earlier commit", () => {
  const { manifest, commit, sha, read } = createInventoryRepository();
  const before = read();
  manifest("core", { id: "core", channels: ["changed"] });
  const next = commit();
  const after = read();
  expect(after.sha256).not.toBe(before.sha256);
  expect(after.source.commit).toBe(next);
  expect(read(sha)).toEqual(before);
  expect(read()).toEqual(after);
});

it("rejects duplicate IDs, malformed JSON and unavailable or non-commit identities", () => {
  const { root, manifest, commit, git, read } = createInventoryRepository();
  expect(() => read("main")).toThrow("full lowercase commit SHA");
  expect(() => read("0".repeat(40))).toThrow();
  expect(() => read(git("rev-parse", "HEAD^{tree}"))).toThrow();
  manifest("source", { id: "core" });
  commit();
  expect(() => read()).toThrow("duplicate manifest ids: core");
  fs.writeFileSync(path.join(root, "extensions/source/openclaw.plugin.json"), "{");
  commit();
  expect(() => read()).toThrow(SyntaxError);
});

it("rejects non-regular metadata instead of following its working-tree target", () => {
  const { git, read } = createInventoryRepository();
  const oid = git("rev-parse", "HEAD:extensions/core/openclaw.plugin.json");
  git("update-index", "--cacheinfo", `120000,${oid},extensions/core/openclaw.plugin.json`);
  git("commit", "-qm", "non-regular metadata");
  expect(() => read()).toThrow("regular Git blob");
});

it.each([
  ["--check", "--commit", "0".repeat(40)],
  ["--json", "--commit"],
  ["--json", "--commit", "0".repeat(40)],
])("fails without partial JSON for invalid export arguments %j", (...args) => {
  const { root } = createInventoryRepository();
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/generate-plugin-inventory-doc.mts"), ...args],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout).toBe("");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("[plugin-inventory] FAILED");
});

it.each<[string, Parameters<typeof doc.resolvePluginSurface>[0], string[]]>([
  [
    "manifest identifiers as inline code",
    {
      id: "example",
      channels: ["discord"],
      providers: ["openai"],
      contracts: { webSearchProviders: {}, tools: {} },
      dashboard: { dataBindings: [{ id: "items.list" }], actionVerbs: [{ id: "refresh" }] },
      skills: ["example"],
      cliCommands: [" voicecall ", "browser", "voicecall", " "].map((name) => ({ name })),
      commandAliases: [
        ...["voice", " voice ", " "].map((name) => ({ name, kind: "runtime-slash" })),
        { name: "internal", kind: "activation-only" },
      ],
    },
    [
      "Channels: `discord`",
      "Providers: `openai`",
      "CLI commands: `openclaw browser`, `openclaw voicecall`",
      "Slash commands: `/voice`",
      "Contracts: `tools`, `webSearchProviders`",
      "Dashboard data bindings: `example.items.list`",
      "Dashboard action verbs: `example.refresh`",
      "Skills",
    ],
  ],
  ["no declared surfaces", {}, []],
  [
    "dashboard delimiter and literal escape markers",
    { id: "dashboard%2E.segmented", dashboard: { dataBindings: [{ id: "refresh" }] } },
    ["Dashboard data bindings: `dashboard%252E%2Esegmented.refresh`"],
  ],
])("renders %s", (_name, manifest, expected) =>
  expect(doc.resolvePluginSurface(manifest)).toEqual(expected),
);

it("detects a manifest directory omitted from the collected source entries", () => {
  const entries = (...ids: string[]) => ids.map((id) => ({ dirName: id, id }));
  expect(() =>
    doc.assertPluginInventoryCoverage(entries("packaged"), entries("manifest-only", "packaged")),
  ).toThrow(/missing dirNames: manifest-only.*missing ids: manifest-only/u);
});
