import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocsDocument } from "../../scripts/lib/docs-markdown.mjs";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { preparedScriptWrapperEnv } from "../../test/scripts/prepared-script-wrapper.test-support.js";
import { writeFixtureFiles as writeFiles } from "../../test/scripts/z0632-fixtures.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

const { auditDocsLinks, prepareExternalLinkAuditTree, prepareMirroredDocsDir } =
  await import("../../scripts/docs-link-audit.mts");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const auditSource = new URL("../../scripts/docs-link-audit.mts", import.meta.url);
const auditRuntime = resolveRuntimeWorkerUrl(scriptModuleEntrypoints.docsLinkAudit);
const syncSource = new URL("../../scripts/docs-sync-publish.mjs", import.meta.url);
const syncRuntime =
  auditRuntime.href === auditSource.href
    ? syncSource
    : new URL("./docs-sync-publish.js", auditRuntime);

type CliOptions = { anchors?: boolean; clawHubRoot?: string; fixtureSync?: string };
function runAuditCli(root: string, { anchors = false, clawHubRoot, fixtureSync }: CliOptions = {}) {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const modules: Array<[URL, URL]> = [[auditSource, auditRuntime]];
  if (fixtureSync) {
    modules.push([syncSource, syncRuntime]);
  }
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../scripts/docs-link-audit.mjs", import.meta.url)),
      ...(anchors ? ["--anchors"] : []),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: preparedScriptWrapperEnv(
        modules,
        {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
          ...(clawHubRoot ? { OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: clawHubRoot } : {}),
        },
        fixtureSync ? [[pathToFileURL(fixtureSync), syncRuntime]] : [],
      ),
    },
  );
}

type AuditOptions = {
  anchors?: boolean;
  diagnostics?: string[];
  files?: Record<string, string>;
  navigation?: string[];
  redirects?: Array<{ source: string; destination: string }>;
};
type AuditCliCase = [name: string, source: string, broken: number, options?: AuditOptions];

function tempEntries(prefix: string): Set<string> {
  return new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix)));
}

it.each<[string, (string | null)[][], string?]>([
  [
    "## Request today's summary\n\n## The vendor's harness, as a plugin",
    [
      ["request-today's-summary", "request-todays-summary"],
      ["the-vendor's-harness%2C-as-a-plugin", "the-vendors-harness-as-a-plugin"],
    ],
  ],
  [
    "## A-s\n\n## As\n\n## A-s\n\n## A-s-2\n\n## A-s",
    [
      ["a-s", null],
      ["as", "as-2"],
      ["a-s-1", "as-3"],
      ["a-s-2", "as-2-1"],
      ["a-s-3", "as-4"],
    ],
    "as",
  ],
  [
    "## café 中文 _Über\n\n## café 中文 _Über\n\n## 1. Today\n\n## 1. Today\n\n## 100% ready",
    [
      ["caf%C3%A9-%E4%B8%AD%E6%96%87-_%C3%BCber", "café-中文-_über"],
      ["caf%C3%A9-%E4%B8%AD%E6%96%87-_%C3%BCber-1", "café-中文-_über-2"],
      ["1.-today", "1-today"],
      ["1.-today-1", "1-today-2"],
      ["100%25-ready", "100%-ready"],
    ],
  ],
])("preserves Mint heading targets for %s", (source, headings, collision) => {
  const document = parseDocsDocument(source);
  expect(
    document.tokens
      .filter((token) => token.type === "heading_open")
      .map((token) => [token.attrGet("id"), token.meta?.anchorAlias ?? null]),
  ).toEqual(headings);
  expect(document.collisions).toEqual(
    collision ? [{ id: collision, reason: "compatibility alias collision" }] : [],
  );
  expect(new Set(document.ids).size).toBe(document.ids.length);
});

it.each<[string, string, string?]>([
  [
    '## Today\'s summary\n\n<Steps titleSize="h2">\n\n<Step title="Today\'s summary">one</Step>\n\n<Step title="Today\'s summary">two</Step>\n\n</Steps>\n\n<Tabs>\n\n<Tab title="Today\'s summary">one</Tab>\n\n<Tab title="Todays summary">two</Tab>\n\n<Tab title="Today\'s summary">three</Tab>\n\n</Tabs>\n\n<Accordion title="A-s">one</Accordion>\n\n<Accordion title="As">two</Accordion>\n\n<ParamField body="a-s">one</ParamField>\n\n<ResponseField name="as">two</ResponseField>',
    "today's-summary todays-summary todays-summary-2 todays-summary-3 todays-summary-1 todays-summary-2-1 todays-summary-3-1 as as-1 param-as param-as-1",
  ],
  [
    '## Today\'s summary\n\n<a id="todays-summary"></a>\n\n<Tab title="A-s">one</Tab>\n\n<Tab id="as" title="Explicit">two</Tab>\n\n<Accordion title="A-s">three</Accordion>\n\n<ParamField body="a-s">four</ParamField>\n\n<a id="param-as"></a>',
    "today's-summary todays-summary as param-as as-1 as-2 param-as-1",
    "todays-summary",
  ],
  [
    '<Accordion title="A-s\'s guide">one</Accordion>\n\n<ParamField body="a-s\'sGuide">two</ParamField>',
    "as-s-guide param-as-s-guide",
  ],
])("preserves Mint component targets for %s", (source, ids, collision) => {
  const document = parseDocsDocument(source);
  expect(document.ids).toEqual(ids.split(" "));
  expect(document.collisions).toEqual(
    collision ? [{ id: collision, reason: "compatibility alias collision" }] : [],
  );
});

it.each<AuditCliCase>([
  [
    "component prose and list fences",
    "<Accordion>\n    ~~~md\n    [example](/hidden-tilde)\n    ~~~not-a-closing-fence\n    [example](/hidden-after-false-close)\n    ~~~\n    [indented](/missing-page)\n</Accordion>\n\n- Example\n\n    ````md\n    ```text\n    [example](/hidden-nested)\n    ```\n    ````\n\n[real](/missing-page)\n[valid](/page)",
    2,
  ],
  [
    "legacy malformed MDX",
    "<!doctype html>\n~~~md\n[example](/hidden-fallback)\n~~~\n[real](/missing-page)\n[valid](/page)",
    1,
  ],
  ["valid prose", "[valid](/page)", 0],
  ...[false, true].map<AuditCliCase>((anchors) => [
    `fenced raw HTML boundaries (anchors=${anchors})`,
    '```html\n\n<code>\n```\n\n<ParamField path="live" type="string">\n[Visible](/missing-page)\n</ParamField>\n\n```html\n</code>\n```\n\n[valid](/page)',
    1,
    { anchors, diagnostics: ["page.mdx:7 :: /missing-page :: route/file not found"] },
  ]),
  [
    "source positions for repeated, reference, HTML, component and relative links",
    '---\ntitle: Positions\n---\n```md\n[hidden](/missing-page)\n```\n[first](/missing-page)\n[second](/missing-page)\n\n`[hidden](/missing-page)` [third](/missing-page)\n[reference][missing]\n\n[missing]: /missing-page\n\n<a href="/missing-page">HTML</a>\n\n<Card href="/missing-page" title="Component" />\n\n[relative](./missing-page.md)\n[valid](/page)',
    7,
    {
      diagnostics: [7, 8, 10, 11, 15, 17, 19].map(
        (line) => `page.mdx:${line} :: /missing-page :: route/file not found`,
      ),
    },
  ],
  [
    "unmapped expansions",
    '<Snippet file="./part.txt" />\n\n<div class="maturity-category-docs">\n[embedded](/missing-page)\n</div>\n\n[valid](/page)',
    2,
    {
      files: { "docs/part.txt": "[included](/missing-page)\n" },
      diagnostics: ["page.mdx:unknown :: /missing-page :: route/file not found"],
    },
  ],
  [
    "decoded direct paths and HTML-alias targets",
    "[direct](/caf%C3%A9#known)\n[literal percent](/100%25#known)\n[asset](/image%20space.svg)\n[redirect](/via)\n[bad redirect](/invalid)\n[raw Markdown redirect](/raw)\n[after](/missing-page)\n[external](/outside)",
    4,
    {
      anchors: true,
      files: {
        "docs/café.md": "## Known\n",
        "docs/100%.md": "## Known\n",
        "docs/image space.svg": "<svg />",
      },
      redirects: [
        { source: "/via", destination: "https://docs.openclaw.ai/caf%C3%A9#known" },
        { source: "/invalid", destination: "https://docs.openclaw.ai/bad%" },
        { source: "/raw", destination: "/café.md#known" },
        { source: "/outside", destination: "https://example.test/page#external-section" },
      ],
      diagnostics: [
        "docs.json:unknown :: /invalid :: malformed URL path",
        "page.mdx:5 :: /invalid :: malformed URL path",
        "page.mdx:6 :: /raw :: fragment requires an HTML page, not raw Markdown",
        "page.mdx:7 :: /missing-page :: route/file not found",
      ],
    },
  ],
  ...[false, true].map<AuditCliCase>((anchors) => [
    `malformed emitted paths (anchors=${anchors})`,
    '<Card href="/bad%" title="Component" />\n\n<a href="/bad%FF">HTML</a>\n\n<img src="/bad%2" />\n\n<CTA primaryHref="/bad%zz" secondaryHref="https://docs.openclaw.ai/bad%" />\n\n[markdown](/bad%FF)\n[reference][bad]\n\n[bad]: /bad%FF\n\n[after](/missing-page)\n[valid](/page)',
    anchors ? 8 : 7,
    {
      anchors,
      diagnostics: [
        ":: /bad% :: malformed URL path",
        ":: /bad%FF :: malformed URL path",
        ":: /missing-page :: route/file not found",
      ],
    },
  ]),
  ...[false, true].map<AuditCliCase>((anchors) => [
    `unpublished permalink routes (anchors=${anchors})`,
    '---\npermalink: /unpublished\n---\n[unpublished](/unpublished)\n[fragment](/unpublished#connection)\n[valid](/page#connection)\n<a id="connection" />',
    3,
    {
      anchors,
      navigation: ["unpublished"],
      diagnostics: [
        "page.mdx:4 :: /unpublished :: route/file not found",
        "page.mdx:5 :: /unpublished#connection :: route/file not found",
        "docs.json:unknown :: unpublished :: navigation page not published",
      ],
    },
  ]),
  [
    "shared emitted fragments",
    '## agents.defaults.cwd\n\n<Accordion title="Connect" id="connection">\n\n## Nested\n\n</Accordion>\n\n[legacy](#agents-defaults-cwd)\n[canonical](#agents.defaults.cwd)\n[component](#connection)\n[nested](https://docs.openclaw.ai/page#nested)\n[absent](#missing)\n[relative](./page.mdx#connection)\n[raw Markdown](/page.md#connection)\n[root](/#root)\n[missing root alias](/index#missing)\n[unpublished permalink](/unpublished#connection)\n[dropped incoming fragment](/drops#missing)\n[redirect](/legacy#wrong-incoming-fragment)\n[chain](/middle#also-wrong)\n[reference][ref]\n\n[ref]: /page#connection\n\n```md\n## Phantom\n[hidden](/hidden-code)\n```\n<!-- <a id="phantom" href="/hidden-comment"> -->',
    4,
    { anchors: true },
  ],
])(
  "audits real CLI links after %s",
  (
    _name,
    source,
    broken,
    { anchors = false, diagnostics, files = {}, navigation = [], redirects }: AuditOptions = {},
  ) => {
    const fixtureRoot = tempDirs.make("docs-link-audit-cli-");
    const docsRoot = path.join(fixtureRoot, "docs");
    const clawHubRoot = path.join(fixtureRoot, "clawhub");
    fs.mkdirSync(path.join(clawHubRoot, "docs"), { recursive: true });
    writeFiles(fixtureRoot, {
      ...files,
      "docs/docs.json": {
        navigation: [{ pages: navigation }],
        redirects:
          redirects ??
          (anchors && !diagnostics
            ? [
                { source: "/legacy", destination: "/page#connection" },
                { source: "/middle", destination: "/legacy#nested" },
                { source: "/drops", destination: "/next" },
              ]
            : []),
      },
      ...(anchors
        ? { "docs/index.md": "## Root\n\n[next](next#target)\n", "docs/next.md": "## Target\n" }
        : {}),
    });
    const pageSource =
      anchors && !diagnostics ? `---\npermalink: /unpublished\n---\n${source}` : source;
    fs.writeFileSync(path.join(docsRoot, "page.mdx"), `${pageSource}\n`);

    const result = runAuditCli(fixtureRoot, { anchors, clawHubRoot });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(broken ? 1 : 0);
    if (!anchors) {
      expect(result.stdout).toContain(`checked_internal_links=${broken + 1}\n`);
    }
    expect(result.stdout).toContain(`broken_links=${broken}\n`);
    expect(result.stdout).not.toContain("/hidden-");
    if (anchors && !diagnostics) {
      expect(result.stdout).toContain("#missing :: fragment not found");
      expect(result.stdout).toContain("/unpublished#connection :: route/file not found");
    }
    for (const diagnostic of diagnostics ?? []) {
      expect(result.stdout).toContain(diagnostic);
    }
    if (broken && !anchors && !diagnostics) {
      expect(result.stdout).toContain(
        `page.mdx:${source.split("\n").findIndex((line) => line.includes("/missing-page")) + 1} :: /missing-page :: route/file not found`,
      );
    }
  },
);

describe("ClawHub routes mirrored from openclaw/clawhub", () => {
  // /clawhub/** pages are authored upstream and injected by the publisher, so a
  // checkout without the ClawHub source has the navigation entries but no pages.
  const buildDocsTree = (
    link: string,
    options: { redirects?: Array<{ source: string; destination: string }>; root?: string } = {},
  ) => {
    const docsRoot = path.join(options.root ?? tempDirs.make("docs-clawhub-mirror-"), "docs");
    writeFiles(docsRoot, {
      "docs.json": {
        navigation: [{ group: "ClawHub", pages: ["clawhub/index", "clawhub/publishing"] }],
        redirects: options.redirects ?? [{ source: "/tools/clawhub", destination: "/clawhub" }],
      },
      "page.md": `## Page\n\n[hub](${link})\n`,
    });
    return docsRoot;
  };

  const fragment = "/clawhub/publishing#package-publish-source";
  const redirected = { redirects: [{ source: "/tools/clawhub", destination: fragment }] };
  const unverified = /fragment unverified.*OPENCLAW_DOCS_SYNC_CLAWHUB_REPO/;
  const missing = /route\/file not found/;
  type MirrorOptions = {
    anchors?: boolean;
    allowExternalClawHubRoutes?: boolean;
    redirect?: boolean;
  };
  it.each<[string, MirrorOptions, RegExp | false, number?]>([
    [fragment, {}, unverified, 1],
    ["/page", { redirect: true }, unverified, 1],
    ["/page", { redirect: true, anchors: false }, false, 0],
    ["/clawhub/not-in-navigation", {}, missing, 1],
    ["/clawhub/publishing", { allowExternalClawHubRoutes: false }, missing],
  ])("audits mirrored route %s (%j)", (link, { redirect = false, ...options }, reason, count) => {
    const result = auditDocsLinks({
      docsDir: buildDocsTree(link, redirect ? redirected : {}),
      anchors: true,
      allowExternalClawHubRoutes: true,
      ...options,
    });
    expect(result.unverifiedMirroredFragments).toBe(reason === unverified ? 1 : 0);
    if (count !== undefined) {
      expect(result.broken).toHaveLength(count);
    }
    if (reason) {
      expect(result.broken).toContainEqual(
        expect.objectContaining({
          reason: expect.stringMatching(reason),
          ...(redirect ? { file: "docs.json", link: "/tools/clawhub" } : {}),
        }),
      );
    }
  });

  it("exits clean from the CLI in plain mode for a fragment into a mirrored route", () => {
    // Resolve source discovery from an owned module root, not the caller's checkout.
    const fixtureRoot = path.join(tempDirs.make("docs-clawhub-mirror-cli-"), "repo");
    const fixtureSync = path.join(fixtureRoot, "scripts", "docs-sync-publish.mjs");
    buildDocsTree(fragment, { root: fixtureRoot });
    fs.mkdirSync(path.dirname(fixtureSync), { recursive: true });
    fs.copyFileSync(syncSource, fixtureSync);
    writeFiles(fixtureRoot, {
      "package.json": '{"private":true,"type":"module"}\n',
      "pnpm-workspace.yaml": "packages: []\n",
    });
    const result = runAuditCli(fixtureRoot, { fixtureSync });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("broken_links=0\n");
    expect(result.stdout).not.toContain("Synced ");
    expect(result.stdout).not.toContain("fragment unverified");
  });
});

function prepareExternal(source: string, projectedLinks: number, rootContent = "") {
  const root = tempDirs.make("docs-external-link-");
  const roots = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
  writeFiles(root, {
    "docs/providers/page.md": source,
    ...Object.fromEntries(roots.map((file) => [file, rootContent])),
  });
  const output = path.join(root, ".audit");
  expect(prepareExternalLinkAuditTree(root, output)).toEqual({ files: 4, projectedLinks });
  for (const file of rootContent ? roots : []) {
    expect(fs.readFileSync(path.join(output, file), "utf8")).toContain('href="https://root.test"');
  }
  const prepared = fs.readFileSync(path.join(output, "docs/providers/page.md"), "utf8").split("\n");
  expect(prepared).toHaveLength(source.split("\n").length);
  return prepared;
}

it("prepares every external-link input without exposing code literals", () => {
  const source = [
    '<AccordionGroup>\n  <Accordion title="Reasoning">\n    [reasoning](https://docs.example.test/reasoning)\n    `https://api.example.test/v1`\n    ````markdown\n    ```text\n    <CODE_PLACEHOLDER>\n    ```\n    ~~~\n    [code literal](https://code.example.test)\n    ~~~\n    ````\n    - ```html\n      <script src="https://code.example.test/list-fence">\n      ```\n      [after list fence](https://docs.example.test/after-list-fence)\n    ```text\n    - ```\n    <Accordion>\n    [fenced component](https://code.example.test/fenced-component)\n    ```\n    [after literal list fence](https://docs.example.test/after-literal-list-fence)\n  </Accordion>\n</AccordionGroup>',
    "<Pre>\n    [pre component](https://docs.example.test/pre-component)\n</Pre>",
    "[reference][shared]\n\n[shared]: https://docs.example.test/reference-first?one=1&two=2\n[shared]: https://docs.example.test/reference-second\n![image](https://docs.example.test/image.png?one=1&two=2)\n",
  ].join("\n");
  const preparedLines = prepareExternal(source, 9, "<div>\n  [root](https://root.test)\n</div>\n");
  const prepared = preparedLines.join("\n");
  expect(preparedLines[2]).toContain('href="https://docs.example.test/reasoning"');
  expect([...prepared.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual(
    "reasoning after-list-fence after-literal-list-fence pre-component reference-first?one=1&amp;two=2 image.png?one=1&amp;two=2"
      .split(" ")
      .map((leaf) => `https://docs.example.test/${leaf}`),
  );
  expect(prepared).not.toMatch(
    /https:\/\/(?:api|code)\.example\.test|https:\/\/docs\.example\.test\/reference-second/,
  );
});

it("falls back to tolerant parsing for legacy malformed MDX", () => {
  const prepared = prepareExternal(
    "<!doctype html>\n<pre>\n[hidden](https://hidden.example.test)\n</pre>\n<Note>\ntext <code>[inline hidden](https://same.example.test)</code> [inline real](https://same.example.test)\n[legacy](https://legacy.example.test)\n</Note>\n<Pre>\n[component](https://component.example.test)\n</Pre>\n[reference][legacy-ref]\n\n[legacy-ref]: https://reference.example.test\n<style><code>[style hidden](https://style.example.test)</code></style> [style real](https://style.example.test)\n```html\n<code>\n[fenced hidden](https://fenced-hidden.example.test)\n```\n<Note>\n[after fence](https://after-fence.example.test)\n</Note>\n",
    6,
  );
  expect(prepared[6]).toContain('href="https://legacy.example.test"');
  expect(prepared[5]?.match(/https:\/\/same\.example\.test/g)).toHaveLength(1);
  expect(prepared[9]).toContain('href="https://component.example.test"');
  expect(prepared[11]).toContain('href="https://reference.example.test"');
  expect(prepared[14]?.match(/https:\/\/style\.example\.test/g)).toHaveLength(1);
  expect(prepared[20]).toContain('href="https://after-fence.example.test"');
  expect(prepared.join("\n")).not.toMatch(/https:\/\/(?:hidden|fenced-hidden)\.example\.test/);
});

it("does not create mirrored docs copies for non-root docs trees", () => {
  const docsRoot = path.join(tempDirs.make("docs-link-audit-mirror-"), "docs");
  fs.mkdirSync(docsRoot, { recursive: true });

  const before = tempEntries("openclaw-docs-link-audit-");
  const mirroredDocsDir = prepareMirroredDocsDir(docsRoot);
  expect(mirroredDocsDir).toMatchObject({ dir: path.resolve(docsRoot), mirroredClawHub: false });
  mirroredDocsDir.cleanup();
  expect(
    [...tempEntries("openclaw-docs-link-audit-")].filter((entry) => !before.has(entry)),
  ).toEqual([]);
});

it("cleans mirrored docs copies when ClawHub sync fails", () => {
  const before = tempEntries("openclaw-docs-link-audit-");

  expect(() =>
    prepareMirroredDocsDir(undefined, {
      resolveClawHubRepoPathImpl: () => path.join(os.tmpdir(), "clawhub-docs"),
      syncClawHubDocsTreeImpl() {
        throw new Error("sync failed");
      },
    }),
  ).toThrow("sync failed");

  expect(
    [...tempEntries("openclaw-docs-link-audit-")].filter((entry) => !before.has(entry)),
  ).toEqual([]);
});
