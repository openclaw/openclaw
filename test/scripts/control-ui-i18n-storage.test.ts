import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeControlUiLocaleCatalog } from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import {
  bootstrapControlUiMemory,
  exportControlUiMemory,
  pinControlUiMemory,
  restoreControlUiMemory,
  refreshControlUiBuildCatalog,
  loadControlUiBuildMemory,
  readControlUiMemoryPin,
  CONTROL_UI_MEMORY_ASSETS,
} from "../../scripts/lib/control-ui-i18n-storage.ts";
import { loadPublicSessionLocales } from "../../scripts/lib/public-session-locales.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const repository = "example/memory-fixture";
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
function init(root: string) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
}
function commit(root: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return git(root, "rev-parse", "HEAD").trim();
}
function fixture() {
  const directory = createTempDir("memory-store-");
  const root = path.join(directory, "source");
  const store = path.join(directory, "store");
  init(root);
  init(store);
  const assets = path.join(root, CONTROL_UI_MEMORY_ASSETS);
  fs.mkdirSync(assets, { recursive: true });
  const raw =
    JSON.stringify({
      cache_key: "copy",
      segment_id: "common.copy",
      segment_ids: ["publicReader.copy"],
      text_hash: createHash("sha256").update("Copy").digest("hex"),
      text: "Copy",
      translated: "Copier",
      src_lang: "en",
      tgt_lang: "fr",
      source_path: "fixture.ts",
      updated_at: "2026-01-01",
    }) + "\n";
  const file = path.join(assets, "fr.tm.jsonl");
  fs.writeFileSync(file, raw);
  commit(root);
  exportControlUiMemory(root, store, ["fr"]);
  const revision = commit(store);
  return { root, store, assets, file, raw, revision };
}

describe("external canonical Control UI memory", () => {
  it("preserves offline translations and exact recovery while future main commits contain only build projections", () => {
    const { root, store, assets, file, raw, revision } = fixture();
    bootstrapControlUiMemory(root, store, repository, revision, ["fr"]);
    const cutover = commit(root);
    expect(fs.existsSync(file)).toBe(false);
    expect(git(root, "ls-files", "--", "*.tm.jsonl")).toBe("");
    expect(loadPublicSessionLocales(root).fr).toEqual({ copy: "Copier" });
    expect(
      materializeControlUiLocaleCatalog(
        new Map([["common.copy", "Copy"]]),
        loadControlUiBuildMemory(file),
      ),
    ).toEqual({ common: { copy: "Copier" } });
    expect(
      materializeControlUiLocaleCatalog(
        new Map([["common.copy", "Changed source"]]),
        loadControlUiBuildMemory(file),
      ),
    ).toEqual({});
    restoreControlUiMemory(root, store, repository);
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
    const catalogBefore = git(
      root,
      "rev-parse",
      "HEAD:" + CONTROL_UI_MEMORY_ASSETS + "/fr.catalog.jsonl",
    ).trim();
    fs.writeFileSync(file, raw.replace("2026-01-01", "2026-01-02"));
    refreshControlUiBuildCatalog(assets, "fr");
    exportControlUiMemory(root, store, ["fr"]);
    pinControlUiMemory(root, store, repository, commit(store));
    commit(root);
    expect(
      git(root, "rev-parse", "HEAD:" + CONTROL_UI_MEMORY_ASSETS + "/fr.catalog.jsonl").trim(),
    ).toBe(catalogBefore);
    fs.writeFileSync(file, raw.replace("Copier", "Copie"));
    refreshControlUiBuildCatalog(assets, "fr");
    exportControlUiMemory(root, store, ["fr"]);
    const next = commit(store);
    pinControlUiMemory(root, store, repository, next);
    commit(root);
    expect(git(root, "log", "--format=%H", cutover + "..HEAD", "--", "*.tm.jsonl")).toBe("");
    expect(git(root, "ls-files", "--", "*.tm.jsonl")).toBe("");
    expect(loadPublicSessionLocales(root).fr).toEqual({ copy: "Copie" });
    expect(git(store, "show", revision + ":fr.tm.jsonl")).toBe(raw);
    fs.unlinkSync(file);
    restoreControlUiMemory(root, store, repository);
    expect(fs.readFileSync(file, "utf8")).toBe(raw.replace("Copier", "Copie"));
    expect(readControlUiMemoryPin(assets)?.revision).toBe(next);
  });

  it("publishes the snapshot before advancing the source pin and stops on a rejected push", () => {
    const { root, store, assets, file, raw, revision } = fixture();
    const remote = path.join(path.dirname(root), "remote.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    git(store, "push", remote, "HEAD:main");
    git(
      store,
      "config",
      "url." + remote + ".insteadOf",
      "https://github.com/" + repository + ".git",
    );
    bootstrapControlUiMemory(root, store, repository, revision, ["fr"]);
    restoreControlUiMemory(root, store, repository);
    fs.writeFileSync(file, raw.replace("Copier", "Copie"));
    refreshControlUiBuildCatalog(assets, "fr");
    exportControlUiMemory(root, store, ["fr"]);
    fs.mkdirSync(path.join(root, ".openclaw/tmp"), { recursive: true });
    fs.symlinkSync(store, path.join(root, ".openclaw/tmp/control-ui-memory-store"), "dir");
    fs.mkdirSync(path.join(root, "scripts"));
    fs.copyFileSync(
      path.resolve("scripts/control-ui-i18n-memory.ts"),
      path.join(root, "scripts/control-ui-i18n-memory.ts"),
    );
    fs.symlinkSync(path.resolve("scripts/lib"), path.join(root, "scripts/lib"), "dir");
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const publish = () =>
      execFileSync(
        "python3",
        [
          path.resolve(".github/actions/git-owner/owner.py"),
          "--policy",
          path.resolve(".github/actions/control-ui-memory/publish.py"),
        ],
        {
          env: {
            ...process.env,
            GITHUB_WORKSPACE: root,
            MEMORY_REPOSITORY: repository,
            MEMORY_TOKEN: "synthetic-fixture-only",
            GIT_ALLOW_PROTOCOL: "file",
          },
          stdio: "pipe",
        },
      );
    const hook = path.join(remote, "hooks/pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(publish).toThrow();
    expect(readControlUiMemoryPin(assets)?.revision).toBe(revision);
    fs.unlinkSync(hook);
    publish();
    const published = readControlUiMemoryPin(assets)!.revision;
    expect(published).toBe(git(remote, "rev-parse", "main").trim());
    expect(git(remote, "show", published + ":fr.tm.jsonl")).toBe(raw.replace("Copier", "Copie"));
    expect(git(remote, "show", revision + ":fr.tm.jsonl")).toBe(raw);
  });

  it("refuses mismatched bootstrap and corrupted snapshots instead of deleting input or falling back to English", () => {
    const { root, store, assets, file, raw, revision } = fixture();
    fs.writeFileSync(file, raw.replace("Copier", "Different"));
    expect(() => bootstrapControlUiMemory(root, store, repository, revision, ["fr"])).toThrow(
      "differs",
    );
    expect(readControlUiMemoryPin(assets)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, raw);
    bootstrapControlUiMemory(root, store, repository, revision, ["fr"]);
    expect(() => restoreControlUiMemory(root, store, "example/other")).toThrow("repository");
    const projected = path.join(assets, "fr.catalog.jsonl");
    fs.appendFileSync(projected, " ");
    expect(() => loadPublicSessionLocales(root)).toThrow("digest mismatch");
    fs.writeFileSync(path.join(store, "fr.tm.jsonl"), raw.replace("Copier", "Different"));
    const bad = commit(store);
    expect(() => pinControlUiMemory(root, store, repository, bad)).toThrow("differs");
    expect(readControlUiMemoryPin(assets)?.revision).toBe(revision);
    // Latest store state never substitutes for the historical pin.
    restoreControlUiMemory(root, store, repository);
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });
});
