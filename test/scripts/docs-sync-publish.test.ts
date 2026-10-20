import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  applyLocaleNavLabelOverlay,
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
const runNode = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, args, { cwd, encoding: "utf8" });
type NavGroup = { group: string; pages: Array<string | NavGroup> };
type NavTab = { tab: string; groups: NavGroup[] };
type DocsConfig = { navigation: { languages: Array<{ language: string; tabs: NavTab[] }> } };
const navGroup = (name: string, pages: NavGroup["pages"]): NavGroup => ({ group: name, pages });
const navFixture = (tab: string, name: string, pages: NavGroup["pages"]) => ({
  tabs: [{ tab, groups: [navGroup(name, pages)] }],
});
function files(root: string) {
  return {
    read: (name: string) => fs.readFileSync(path.join(root, name), "utf8"),
    json: (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")),
    append: (name: string, text: string) => fs.appendFileSync(path.join(root, name), text),
    write: (name: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    },
    exists: (name: string) => fs.existsSync(path.join(root, name)),
    linkDependencies: (
      type: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir",
    ) => {
      fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), type);
    },
  };
}
function publisherFixture(
  version = sourceSlugifyVersion,
  { sourceSha, index }: { sourceSha?: string; index?: string } = { index: "# ClawHub\n" },
) {
  const root = tempDirs.make("openclaw-docs-sync-");
  const publishRoot = path.join(root, "publish");
  const clawhubRoot = path.join(root, "clawhub");
  fs.mkdirSync(path.join(clawhubRoot, "docs"), { recursive: true });
  if (index !== undefined) {
    files(clawhubRoot).write("docs/index.md", index);
  }
  writePublisherDependencies(publishRoot, publisherDependencies(version));
  const sync = (env?: NodeJS.ProcessEnv) =>
    execFileSync(
      process.execPath,
      [
        "scripts/docs-sync-publish.mjs",
        "--target",
        publishRoot,
        "--clawhub-repo",
        clawhubRoot,
        ...(sourceSha ? ["--source-sha", sourceSha] : []),
      ],
      { stdio: "pipe", ...(env && { env }) },
    );
  return { root, publishRoot, sync, ...files(publishRoot) };
}

function publisherDependencies(version: string, markdownVersion = "15.0.0") {
  const devDependencies = { [slugifyPackage]: version, "markdown-it": markdownVersion };
  return {
    packageJson: { name: "docs-test", private: true, devDependencies },
    packageLock: {
      name: "docs-test",
      lockfileVersion: 3,
      packages: {
        "": { name: "docs-test", devDependencies: { ...devDependencies } },
        [`node_modules/${slugifyPackage}`]: { version },
        "node_modules/markdown-it": { version: markdownVersion },
      },
    },
  };
}

type Dependencies = ReturnType<typeof publisherDependencies>;
function writePublisherDependencies(publishRoot: string, dependencies: Dependencies) {
  const { write } = files(publishRoot);
  write("package.json", JSON.stringify(dependencies.packageJson));
  write("package-lock.json", JSON.stringify(dependencies.packageLock));
}

type NavEntry =
  | string
  | { page?: string; pages?: NavEntry[]; groups?: NavEntry[]; tabs?: NavEntry[] };
function collectPages(entry: NavEntry | NavEntry[] | undefined): string[] {
  if (!entry) {
    return [];
  }
  if (typeof entry === "string") {
    return [entry];
  }
  if (Array.isArray(entry)) {
    return entry.flatMap((item) => collectPages(item));
  }
  return [entry.page, entry.pages, entry.groups, entry.tabs].flatMap(collectPages);
}
function findNestedGroup(pages: NavGroup["pages"] | undefined, name: string): NavGroup | undefined {
  for (const entry of pages ?? []) {
    if (typeof entry === "string") {
      continue;
    }
    const found = entry.group === name ? entry : findNestedGroup(entry.pages, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}
const findNestedGroupByPage = (pages: NavGroup["pages"] | undefined, page: string) =>
  pages?.find((entry) => typeof entry !== "string" && collectPages(entry.pages).includes(page));
function expectFirstLabels(locale: { tabs: NavTab[] } | undefined, tab: string, group: string) {
  const first = locale!.tabs[0];
  expect({ tab: first?.tab, group: first?.groups?.[0]?.group }).toEqual({ tab, group });
}
const findTab = (locale: { tabs: NavTab[] } | undefined, tab: string) =>
  locale!.tabs.find((entry) => entry.tab === tab);
const authoredEnglish = (files("docs").json("docs.json") as DocsConfig).navigation.languages.find(
  (entry) => entry.language === "en",
)!;
const englishTabs = authoredEnglish.tabs.filter((tab) => tab.tab !== "ClawHub");

it("reuses only exact successful page checks and checks docs.json on warm runs", () => {
  const root = fs.realpathSync(tempDirs.make("openclaw-mdx-cache-"));
  const { read, write, json, append } = files(root);
  const checker = path.join(root, ".openclaw-sync", "check-docs-mdx.mts");
  fs.mkdirSync(path.join(root, ".openclaw-sync", "lib"), { recursive: true });
  for (const name of ["check-docs-mdx.mts", "lib/arg-utils.runtime.mjs"]) {
    fs.copyFileSync(path.join("scripts", name), path.join(root, ".openclaw-sync", name));
  }
  files(path.join(root, ".openclaw-sync")).linkDependencies("junction");
  // Synthetic lock inputs; dependency code stays in the read-only shared install.
  for (const name of ["package.json", "package-lock.json", "node_modules/.package-lock.json"]) {
    write(name, "{}\n");
  }
  const cache = path.join(root, "cache.json");
  const reportPath = path.join(root, "report.json");
  write("docs/a.md", "# A\n");
  write("docs/b.mdx", "# B\n");
  write("docs/docs.json", "{}");
  const run = (status = 0) => {
    const result = spawnSync(
      process.execPath,
      [checker, "docs", "--cache-file", cache, "--json-out", reportPath],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(status);
    return json("report.json");
  };
  expect(run().cacheHits).toBe(0);
  expect(run().cacheHits).toBe(2);
  const successful = read("cache.json");
  write("docs/a.md", "---\nsummary: functions.exec\n---\n# A\n");
  expect(run(1).errors[0].type).toBe("poison-text");
  expect(read("cache.json")).toBe(successful);
  write("docs/a.md", "# Changed\n");
  expect(run().cacheHits).toBe(1);
  write("docs/docs.json", '{"navigation":{"language":"unknown"}}');
  expect(run(1)).toMatchObject({ cacheHits: 2, errors: [{ type: "docs-json" }] });
  write("docs/docs.json", "{}");
  fs.unlinkSync(path.join(root, "docs/a.md"));
  fs.renameSync(path.join(root, "docs", "b.mdx"), path.join(root, "docs", "b.MD"));
  expect(run().cacheHits).toBe(0);
  expect(Object.keys(json("cache.json").files)).toEqual(["docs/b.MD"]);
  for (const name of [
    ".openclaw-sync/check-docs-mdx.mts",
    "package-lock.json",
    "node_modules/.package-lock.json",
  ]) {
    append(name, "\n");
    expect(run().cacheHits).toBe(0);
  }
  fs.writeFileSync(cache, "{corrupt");
  expect(run().cacheHits).toBe(0);
});

it("executes the copied MDX checker and shared anchor runtime closures", () => {
  const { root, publishRoot, read, write, json, sync } = publisherFixture();
  const minimalMdx = path.join(root, "valid.mdx");
  files(root).write("valid.mdx", "# Valid MDX\n\nThis file is valid.\n");
  const translation = "<Note>\n  </Note>\n";
  write("docs/fa/index.md", translation);
  files(publishRoot).linkDependencies();
  sync();
  runNode(publishRoot, path.join(publishRoot, ".openclaw-sync/check-docs-mdx.mjs"), minimalMdx);
  expect(read("docs/fa/index.md")).toBe(translation);
  expect(read("docs/reference/templates/AGENTS.md")).toBe(
    fs.readFileSync("docs/reference/templates/AGENTS.md", "utf8"),
  );
  const published = json("docs/docs.json");
  expect(
    published.navigation.languages.map((entry: { language: string }) => entry.language),
  ).toEqual(expect.arrayContaining(["fa", "th"]));
  const anchors = runNode(
    publishRoot,
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
  );
  expect(anchors).toBe('["agents.defaults.cwd","agents-defaults-cwd"]\n0\n');
});

it.each([
  { fault: "none", error: undefined },
  { fault: "exit", error: "npm lock failure" },
  { fault: "stale", error: "publisher manifest and lock must both pin" },
])("syncs an independent publisher lock with $fault outcome", async ({ fault, error }) => {
  const fixture = publisherFixture("2.2.0", {
    sourceSha: "fixture-source",
  });
  const { root, publishRoot, exists, read, write, json, append } = fixture;
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const baseline = publisherDependencies("2.2.0");
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
fs.writeFileSync('package.json', JSON.stringify(manifest));
fs.writeFileSync('package-lock.json', JSON.stringify(lock));
`,
    { mode: 0o755 },
  );
  const sync = () =>
    fixture.sync({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
  if (error) {
    expect(sync).toThrow(error);
    expect(exists(".openclaw-sync/source.json")).toBe(false);
    return;
  }
  sync();
  expect({ packageJson: json("package.json"), packageLock: json("package-lock.json") }).toEqual(
    publisherDependencies(sourceSlugifyVersion),
  );
  expect(exists("node_modules")).toBe(false);
  const { validateDocsSyncDependencies } = await import("../../scripts/docs-sync-publish.mjs");
  const validate = (expected: Dependencies) => validateDocsSyncDependencies(publishRoot, expected);
  validate(baseline);
  sync();
  expect(read("npm-calls")).toBe("called\n");

  // Rebase validation must detect lost unrelated updates from fresh publisher main.
  const freshMain = publisherDependencies("2.2.0", "15.0.1");
  expect(() => validate(freshMain)).toThrow("changed unrelated publisher dependencies");
  const rebased = publisherDependencies(sourceSlugifyVersion, "15.0.1");
  writePublisherDependencies(publishRoot, rebased);
  const reordered = Object.fromEntries(Object.entries(rebased.packageLock).toReversed());
  write("package-lock.json", JSON.stringify(reordered, null, 4));
  expect(() => validate(freshMain)).not.toThrow();
  append(".openclaw-sync/lib/docs-markdown.mjs", "\n// drift\n");
  expect(() => validate(freshMain)).toThrow("support file differs from source");
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
    for (const tail of [[], ["--target", "generated-docs"], ["-h"]]) {
      expect(() => parseArgs([flag, ...tail])).toThrow(`${flag} requires a value`);
    }
  }
});

it("defers orphan locale deletion to translation finalization", () => {
  const docsDir = tempDirs.make("openclaw-docs-sync-");
  const { write, exists } = files(docsDir);
  write("clawhub/api.md", "# ClawHub API\n");
  write("de/clawhub/api.md", "# ClawHub-API\n");
  write("de/removed.md", "# Removed\n");
  expect(reportOrphanLocaleDocs(docsDir)).toBe(1);
  expect([exists("de/clawhub/api.md"), exists("de/removed.md")]).toEqual([true, true]);
});

it("overlays deep groups without changing the input or ambiguously labeling siblings", () => {
  const source = navFixture("Tools", "Guides", [
    navGroup("Browser", [navGroup("Setup", ["tr/browser/setup"])]),
    navGroup("Search", ["tr/search"]),
  ]);
  const before = structuredClone(source);
  const result = applyLocaleNavLabelOverlay(
    source,
    navFixture("Araçlar", "Kılavuzlar", [
      navGroup("Tarayıcı", [navGroup("Kurulum", ["tr/browser/setup"])]),
      navGroup("Combined", ["tr/browser/setup", "tr/search"]),
    ]),
  );
  expect(source).toEqual(before);
  expect(collectPages(result)).toEqual(collectPages(source));
  expect(result.tabs[0].groups[0]).toEqual(
    navGroup("Kılavuzlar", [
      navGroup("Tarayıcı", [navGroup("Kurulum", ["tr/browser/setup"])]),
      navGroup("Search", ["tr/search"]),
    ]),
  );
});

it("covers every published Swedish navigation label with a matching English anchor", () => {
  const glossary = new Map<string, string>(
    files("docs/.i18n")
      .json("glossary.sv.json")
      .map((entry: { source: string; target: string }) => [entry.source, entry.target]),
  );
  const label = (value: string) => {
    expect(glossary.has(value), value).toBe(true);
    return glossary.get(value)!;
  };
  const group = (entry: NavGroup, translated: boolean): NavGroup => ({
    group: translated ? label(entry.group) : entry.group,
    pages: entry.pages.map((page) =>
      typeof page === "string" ? `sv/${page}` : group(page, translated),
    ),
  });
  const overlay = files("docs/.i18n").json("sv-navigation.json");
  const navigation = (translated: boolean) => ({
    language: "sv",
    tabs: englishTabs.map((tab) => ({
      tab: translated ? label(tab.tab) : tab.tab,
      groups: tab.groups.map((entry) => group(entry, translated)),
    })),
  });
  expect(applyLocaleNavLabelOverlay(navigation(false), overlay)).toEqual(navigation(true));
});

it("keeps generated locale navigation aligned with English routes", () => {
  const config = composeDocsConfig() as DocsConfig;
  const [english, chinese, german, turkish, swedish] = ["en", "zh-Hans", "de", "tr", "sv"].map(
    (code) => {
      const locale = config.navigation.languages.find((entry) => entry.language === code);
      expect(locale).toBeDefined();
      return locale!;
    },
  );
  expect(english).toEqual(authoredEnglish);

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

  expectFirstLabels(chinese, "快速开始", "首页");
  for (const [tab, groups] of [
    ["发布", ["发布说明", "发布流程"]],
    ["贡献", ["成熟度", "测试与 CI"]],
  ] as const) {
    expect(findTab(chinese, tab)?.groups.map((group) => group.group)).toEqual(groups);
  }
  expectFirstLabels(swedish, "Kom igång", "Översikt");
  expectFirstLabels(german, "Loslegen", "Überblick");

  const chineseGateway = findTab(chinese, "网关与运维")?.groups.find(
    (group) => group.group === "网关",
  );
  for (const [page, group] of [
    ["zh-CN/gateway/configuration", "Configuration"],
    ["zh-CN/gateway/authentication", "Authentication and secrets"],
    ["zh-CN/gateway/health", "Health and diagnostics"],
    ["zh-CN/gateway/gateway-lock", "Scaling and operations"],
  ] as const) {
    expect(findNestedGroupByPage(chineseGateway?.pages, page)).toEqual(
      expect.objectContaining({ group }),
    );
  }

  expect(turkish!.tabs.map((tab) => tab.tab)).toEqual([
    "Başlangıç",
    "Kurulum",
    "Kanallar",
    "Ajanlar",
    "Yetenekler",
    "Modeller",
    "Platformlar",
    "Gateway ve operasyonlar",
    "Başvuru",
    "Sürümler",
    "Katkıda bulunma",
    "Yardım",
  ]);
  expect(turkish!.tabs[0]?.groups?.[0]?.group).toBe("Genel bakış");
  for (const [tab, parent, child, page] of [
    ["Kurulum", "Bakım", "Geçiş", "tr/install/migrating"],
    ["Ajanlar", "Oturumlar ve bellek", "Active Memory", "tr/concepts/active-memory/enabling"],
    ["Yetenekler", "Plugin kılavuzları", "Codex harness", "tr/plugins/codex-harness/placement"],
    ["Yetenekler", "Araçlar", "Tarayıcı", "tr/tools/browser/setup"],
    ["Gateway ve operasyonlar", "Gateway", "OpenTelemetry", "tr/gateway/opentelemetry/setup"],
    ["Başvuru", "CLI komutları", "Gateway", "tr/cli/gateway/running"],
  ] as const) {
    const parentGroup = findTab(turkish, tab)?.groups.find((entry) => entry.group === parent);
    expect(findNestedGroup(parentGroup?.pages, child)).toEqual(
      expect.objectContaining({ pages: expect.arrayContaining([page]) }),
    );
  }
});
