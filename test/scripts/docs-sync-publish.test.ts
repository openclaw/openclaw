import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeDocsConfig,
  parseArgs,
  reportOrphanLocaleDocs,
} from "../../scripts/docs-sync-publish.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const slugifyPackage = "@sindresorhus/slugify";
const sourceSlugifyVersion = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).devDependencies[slugifyPackage] as string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function publisherDependencies(version: string) {
  const devDependencies = { [slugifyPackage]: version, "markdown-it": "15.0.0" };
  return {
    packageJson: { name: "docs-test", private: true, devDependencies },
    packageLock: {
      name: "docs-test",
      lockfileVersion: 3,
      packages: {
        "": { name: "docs-test", devDependencies: { ...devDependencies } },
        [`node_modules/${slugifyPackage}`]: { version },
        "node_modules/markdown-it": { version: "15.0.0" },
      },
    },
  };
}

function writePublisherDependencies(
  publishRoot: string,
  dependencies: ReturnType<typeof publisherDependencies>,
) {
  fs.writeFileSync(
    path.join(publishRoot, "package.json"),
    JSON.stringify(dependencies.packageJson),
  );
  fs.writeFileSync(
    path.join(publishRoot, "package-lock.json"),
    JSON.stringify(dependencies.packageLock),
  );
}

function readPublisherDependencies(publishRoot: string): ReturnType<typeof publisherDependencies> {
  return {
    packageJson: JSON.parse(fs.readFileSync(path.join(publishRoot, "package.json"), "utf8")),
    packageLock: JSON.parse(fs.readFileSync(path.join(publishRoot, "package-lock.json"), "utf8")),
  };
}

function collectPages(entry: unknown, pages: string[] = []): string[] {
  if (typeof entry === "string") {
    pages.push(entry);
    return pages;
  }
  if (Array.isArray(entry)) {
    for (const item of entry) {
      collectPages(item, pages);
    }
    return pages;
  }
  if (!entry || typeof entry !== "object") {
    return pages;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.page === "string") {
    pages.push(record.page);
  }
  collectPages(record.pages, pages);
  collectPages(record.groups, pages);
  collectPages(record.tabs, pages);
  return pages;
}

describe("docs-sync-publish", () => {
  it("reuses only exact successful page checks and checks docs.json on warm runs", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mdx-cache-")));
    try {
      const checker = path.join(root, ".openclaw-sync", "check-docs-mdx.mts");
      fs.mkdirSync(path.join(root, ".openclaw-sync", "lib"), { recursive: true });
      for (const name of ["check-docs-mdx.mts", "lib/arg-utils.runtime.mjs"]) {
        fs.copyFileSync(path.join("scripts", name), path.join(root, ".openclaw-sync", name));
      }
      fs.symlinkSync(
        path.resolve("node_modules"),
        path.join(root, ".openclaw-sync", "node_modules"),
        "junction",
      );
      fs.mkdirSync(path.join(root, "node_modules"));
      // Synthetic requested/installed lock inputs; dependency code stays in the
      // read-only shared install. This fixture never runs npm.
      for (const name of ["package.json", "package-lock.json", "node_modules/.package-lock.json"]) {
        fs.writeFileSync(path.join(root, name), "{}\n");
      }
      fs.mkdirSync(path.join(root, "docs"));
      const page = path.join(root, "docs", "a.md");
      const config = path.join(root, "docs", "docs.json");
      const cache = path.join(root, "cache.json");
      const reportPath = path.join(root, "report.json");
      fs.writeFileSync(page, "# A\n");
      fs.writeFileSync(path.join(root, "docs", "b.mdx"), "# B\n");
      fs.writeFileSync(config, "{}");
      const run = (status = 0) => {
        const result = spawnSync(
          process.execPath,
          [checker, "docs", "--cache-file", cache, "--json-out", reportPath],
          { cwd: root, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(status);
        return JSON.parse(fs.readFileSync(reportPath, "utf8"));
      };
      expect(run().cacheHits).toBe(0);
      expect(run().cacheHits).toBe(2);
      const successful = fs.readFileSync(cache, "utf8");
      fs.writeFileSync(page, "---\nsummary: functions.exec\n---\n# A\n");
      expect(run(1).errors[0].type).toBe("poison-text");
      expect(fs.readFileSync(cache, "utf8")).toBe(successful);
      fs.writeFileSync(page, "# Changed\n");
      expect(run().cacheHits).toBe(1);
      fs.writeFileSync(config, '{"navigation":{"language":"unknown"}}');
      expect(run(1)).toMatchObject({ cacheHits: 2, errors: [{ type: "docs-json" }] });
      fs.writeFileSync(config, "{}");
      fs.unlinkSync(page);
      fs.renameSync(path.join(root, "docs", "b.mdx"), path.join(root, "docs", "b.MD"));
      expect(run().cacheHits).toBe(0);
      expect(Object.keys(JSON.parse(fs.readFileSync(cache, "utf8")).files)).toEqual(["docs/b.MD"]);
      for (const name of [
        ".openclaw-sync/check-docs-mdx.mts",
        "package-lock.json",
        "node_modules/.package-lock.json",
      ]) {
        fs.appendFileSync(path.join(root, name), "\n");
        expect(run().cacheHits).toBe(0);
      }
      fs.writeFileSync(cache, "{corrupt");
      expect(run().cacheHits).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the copied MDX checker and shared anchor runtime closures", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-sync-runtime-"));
    const publishRoot = path.join(tempRoot, "publish");
    const clawhubRoot = path.join(tempRoot, "clawhub");
    const minimalMdx = path.join(tempRoot, "valid.mdx");

    fs.mkdirSync(publishRoot, { recursive: true });
    fs.mkdirSync(path.join(clawhubRoot, "docs"), { recursive: true });
    writePublisherDependencies(publishRoot, publisherDependencies(sourceSlugifyVersion));
    fs.writeFileSync(path.join(clawhubRoot, "docs", "index.md"), "# ClawHub\n");
    fs.writeFileSync(minimalMdx, "# Valid MDX\n\nThis file is valid.\n");
    fs.mkdirSync(path.join(publishRoot, "docs", "fa"), { recursive: true });
    const translation = "<Note>\n  </Note>\n";
    fs.writeFileSync(path.join(publishRoot, "docs", "fa", "index.md"), translation);
    fs.symlinkSync(
      path.resolve("node_modules"),
      path.join(publishRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    try {
      execFileSync(
        process.execPath,
        ["scripts/docs-sync-publish.mjs", "--target", publishRoot, "--clawhub-repo", clawhubRoot],
        { stdio: "pipe" },
      );
      execFileSync(
        process.execPath,
        [path.join(publishRoot, ".openclaw-sync", "check-docs-mdx.mjs"), minimalMdx],
        { cwd: publishRoot, stdio: "pipe" },
      );
      expect(fs.readFileSync(path.join(publishRoot, "docs", "fa", "index.md"), "utf8")).toBe(
        translation,
      );
      // Repository instruction exclusions must not hide the public workspace template.
      expect(
        fs.readFileSync(
          path.join(publishRoot, "docs", "reference", "templates", "AGENTS.md"),
          "utf8",
        ),
      ).toBe(fs.readFileSync(path.join("docs", "reference", "templates", "AGENTS.md"), "utf8"));
      const published = JSON.parse(
        fs.readFileSync(path.join(publishRoot, "docs", "docs.json"), "utf8"),
      );
      expect(
        published.navigation.languages.map((entry: { language: string }) => entry.language),
      ).toEqual(expect.arrayContaining(["fa", "th"]));
      const anchors = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          String.raw`
        import assert from 'node:assert/strict';
        import { parseDocsDocument } from './.openclaw-sync/lib/docs-markdown.mjs';
        import { resolveRedirects } from './.openclaw-sync/lib/docs-redirects.mjs';
        const redirect = (source, destination) => resolveRedirects({
          redirects: [{ source, destination }], pages: [], localeCodes: ['en'], prefixes: [], publicPath: x => x,
        });
        const rejected = [...Array.from({ length: 33 }, (_, code) => String.fromCharCode(code)), '<', '>', '\\', '*'];
        for (const character of rejected) {
          assert.throws(() => redirect('/a' + character + 'b', 'https://example.com/valid'), /Unsafe redirect path/);
          for (const prefix of ['/', 'https://example.com/']) {
            assert.throws(() => redirect('/from', prefix + 'a' + character + 'b.png'), /Unsupported redirect destination/);
          }
        }
        for (const route of ['/a:b', '/a%2Fb', '/a%5Cb', '/a/%2e%2e/b', '/a/%2E/b', '/bad%zz']) {
          assert.throws(() => redirect(route, 'https://example.com/valid'), /Unsafe redirect path/);
          assert.throws(() => redirect('/from', route + '.png'), /Unsafe redirect path/);
        }
        for (const [source, destination] of [
          ['/日本語/🦞', '/目標.png'],
          ['/encoded%20%00%3C%3E%2A%3A', '/encoded%20%00%3C%3E%2A%3A.png'],
          ['/nonbreaking\u00a0space', '/nonbreaking\u00a0space.png'],
          ['/del\u007fbyte', '/del\u007fbyte.png'],
          ['/query', '/image.png?q=a:b#c:d'],
          ['/external', 'https://example.com/a:b/%2F?q=é#章'],
        ]) {
          assert.deepEqual(redirect(source, destination), [{ source, destination }]);
        }
        console.log(JSON.stringify(parseDocsDocument('## agents.defaults.cwd').ids));
        console.log(resolveRedirects({redirects: [], pages: [], localeCodes: ['en'], prefixes: [], publicPath: x => x}).length);
      `,
        ],
        { cwd: publishRoot, encoding: "utf8" },
      );
      expect(anchors).toBe('["agents.defaults.cwd","agents-defaults-cwd"]\n0\n');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { fault: "none", error: undefined },
    { fault: "exit", error: "npm lock failure" },
    { fault: "unrelated", error: "changed unrelated publisher dependencies" },
    { fault: "stale", error: "publisher manifest and lock must both pin" },
  ])("syncs an independent publisher lock with $fault outcome", async ({ fault, error }) => {
    const fixture = tempDirs.make("openclaw-docs-sync-dependencies-");
    const publishRoot = path.join(fixture, "publish");
    const clawhubRoot = path.join(fixture, "clawhub");
    const bin = path.join(fixture, "bin");
    fs.mkdirSync(publishRoot);
    fs.mkdirSync(path.join(clawhubRoot, "docs"), { recursive: true });
    fs.mkdirSync(bin);
    const baseline = publisherDependencies("2.2.0");
    writePublisherDependencies(publishRoot, baseline);
    // npm's graph resolution has separate real-install proof. This CLI fixture
    // injects lock-generation failures without network or root dependency leakage.
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!${process.execPath}\n` +
        String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fault = ${JSON.stringify(fault)};
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, -1), ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', '--save-exact']);
if (fault === 'exit') { console.error('npm lock failure'); process.exit(17); }
fs.appendFileSync('npm-calls', 'called\n');
const name = '@sindresorhus/slugify';
const version = args.at(-1).slice(name.length + 1);
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
manifest.devDependencies[name] = version;
lock.packages[''].devDependencies[name] = version;
if (fault !== 'stale') lock.packages['node_modules/' + name].version = version;
if (fault === 'unrelated') lock.packages['node_modules/markdown-it'].version = '15.0.1';
fs.writeFileSync('package.json', JSON.stringify(manifest));
fs.writeFileSync('package-lock.json', JSON.stringify(lock));
`,
      { mode: 0o755 },
    );
    const sync = () =>
      execFileSync(
        process.execPath,
        [
          "scripts/docs-sync-publish.mjs",
          "--target",
          publishRoot,
          "--clawhub-repo",
          clawhubRoot,
          "--source-sha",
          "fixture-source",
        ],
        {
          stdio: "pipe",
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        },
      );
    if (error) {
      expect(sync).toThrow(error);
      expect(fs.existsSync(path.join(publishRoot, ".openclaw-sync", "source.json"))).toBe(false);
      return;
    }
    sync();
    expect(readPublisherDependencies(publishRoot)).toEqual(
      publisherDependencies(sourceSlugifyVersion),
    );
    expect(fs.existsSync(path.join(publishRoot, "node_modules"))).toBe(false);
    const { validateDocsSyncDependencies } = await import("../../scripts/docs-sync-publish.mjs");
    validateDocsSyncDependencies(publishRoot, baseline);
    sync();
    expect(fs.readFileSync(path.join(publishRoot, "npm-calls"), "utf8")).toBe("called\n");

    // Post-rebase validation compares with fresh publisher main, not the clone's
    // old dependency snapshot. Losing an unrelated maintainer update must fail.
    const freshMain = structuredClone(baseline);
    freshMain.packageJson.devDependencies["markdown-it"] = "15.0.1";
    freshMain.packageLock.packages[""].devDependencies["markdown-it"] = "15.0.1";
    freshMain.packageLock.packages["node_modules/markdown-it"].version = "15.0.1";
    expect(() => validateDocsSyncDependencies(publishRoot, freshMain)).toThrow(
      "changed unrelated publisher dependencies",
    );
    const rebased = structuredClone(freshMain);
    rebased.packageJson.devDependencies[slugifyPackage] = sourceSlugifyVersion;
    rebased.packageLock.packages[""].devDependencies[slugifyPackage] = sourceSlugifyVersion;
    rebased.packageLock.packages[`node_modules/${slugifyPackage}`].version = sourceSlugifyVersion;
    writePublisherDependencies(publishRoot, rebased);
    const reordered = Object.fromEntries(Object.entries(rebased.packageLock).toReversed());
    fs.writeFileSync(
      path.join(publishRoot, "package-lock.json"),
      JSON.stringify(reordered, null, 4),
    );
    expect(() => validateDocsSyncDependencies(publishRoot, freshMain)).not.toThrow();
    fs.appendFileSync(
      path.join(publishRoot, ".openclaw-sync", "lib", "docs-markdown.mjs"),
      "\n// drift\n",
    );
    expect(() => validateDocsSyncDependencies(publishRoot, freshMain)).toThrow(
      "support file differs from source",
    );
  });

  it("rejects missing docs sync option values", () => {
    for (const flag of [
      "--target",
      "--source-repo",
      "--source-sha",
      "--clawhub-repo",
      "--clawhub-source-repo",
      "--clawhub-source-sha",
    ]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "--target", "generated-docs"])).toThrow(
        `${flag} requires a value`,
      );
      expect(() => parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
    }
  });

  it("defers orphan locale deletion to translation finalization", () => {
    const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-sync-"));
    const mirroredEnglish = path.join(docsDir, "clawhub", "api.md");
    const localizedMirror = path.join(docsDir, "de", "clawhub", "api.md");
    const orphan = path.join(docsDir, "de", "removed.md");

    fs.mkdirSync(path.dirname(mirroredEnglish), { recursive: true });
    fs.mkdirSync(path.dirname(localizedMirror), { recursive: true });
    fs.writeFileSync(mirroredEnglish, "# ClawHub API\n");
    fs.writeFileSync(localizedMirror, "# ClawHub-API\n");
    fs.writeFileSync(orphan, "# Removed\n");

    try {
      expect(reportOrphanLocaleDocs(docsDir)).toBe(1);
      expect(fs.existsSync(localizedMirror)).toBe(true);
      expect(fs.existsSync(orphan)).toBe(true);
    } finally {
      fs.rmSync(docsDir, { recursive: true, force: true });
    }
  });

  it("keeps generated locale navigation aligned with English routes", () => {
    const config = composeDocsConfig() as {
      navigation: {
        languages: Array<{
          language: string;
          tabs: Array<{
            tab: string;
            groups?: Array<{ group: string; pages?: unknown }>;
          }>;
        }>;
      };
    };
    const english = config.navigation.languages.find((entry) => entry.language === "en");
    const simplifiedChinese = config.navigation.languages.find(
      (entry) => entry.language === "zh-Hans",
    );
    const german = config.navigation.languages.find((entry) => entry.language === "de");

    expect(english).toBeDefined();
    expect(simplifiedChinese).toBeDefined();
    expect(german).toBeDefined();
    const sourceConfig = JSON.parse(
      fs.readFileSync(path.join("docs", "docs.json"), "utf8"),
    ) as typeof config;
    expect(english).toEqual(
      sourceConfig.navigation.languages.find((entry) => entry.language === "en"),
    );

    // Authored navigation owns the inventory; localization must preserve each tab and group.
    const englishTabs = english!.tabs.filter((tab) => tab.tab !== "ClawHub");
    const localeDirs: Record<string, string> = {
      "zh-Hans": "zh-CN",
      "zh-Hant": "zh-TW",
      ja: "ja-JP",
    };
    for (const locale of config.navigation.languages.filter((entry) => entry.language !== "en")) {
      const prefix = localeDirs[locale.language] ?? locale.language;
      const localize = (page: string) => `${prefix}/${page}`;
      expect(locale.tabs).toHaveLength(englishTabs.length);
      for (const [index, tab] of englishTabs.entries()) {
        expect(collectPages(locale.tabs[index])).toEqual(collectPages(tab).map(localize));
        expect(locale.tabs[index]?.groups?.map((group) => collectPages(group))).toEqual(
          tab.groups?.map((group) => collectPages(group).map(localize)),
        );
      }
    }

    expect(simplifiedChinese!.tabs[0]?.tab).toBe("快速开始");
    expect(simplifiedChinese!.tabs[0]?.groups?.[0]?.group).toBe("首页");
    expect(
      simplifiedChinese!.tabs
        .find((tab) => tab.tab === "发布")
        ?.groups?.map((group) => group.group),
    ).toEqual(["发布说明", "发布流程"]);
    expect(
      simplifiedChinese!.tabs
        .find((tab) => tab.tab === "贡献")
        ?.groups?.map((group) => group.group),
    ).toEqual(["成熟度", "测试与 CI"]);
    expect(german!.tabs[0]?.tab).toBe("Loslegen");
    expect(german!.tabs[0]?.groups?.[0]?.group).toBe("Überblick");
  });
});
