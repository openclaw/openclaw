import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDocsMarkdown, parseDocsDocument } from "../../scripts/lib/docs-markdown.mjs";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { preparedScriptWrapperEnv } from "../../test/scripts/prepared-script-wrapper.test-support.js";
import { writeFixtureFiles as writeFiles } from "../../test/scripts/z0632-fixtures.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

const { auditDocsLinks, prepareExternalLinkAuditTree, prepareMirroredDocsDir } =
  await import("../../scripts/docs-link-audit.mts");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const lines = (...blocks: string[]) => blocks.join("\n").split("\n");
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

type AuditCliCase = {
  name: string;
  source: string[];
  broken: number;
  anchors?: boolean;
  diagnostics?: string[];
  files?: Record<string, string>;
  navigation?: string[];
  redirects?: Array<{ source: string; destination: string }>;
};

function tempEntries(prefix: string): Set<string> {
  return new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix)));
}

it.each(["\n", "\r\n"])("preserves code literals with line ending %j", (newline) => {
  const source = lines(
    'Intro\n\n```md\n<Card href="/same" title="Literal" />\n```\n\n[live](/same)',
  ).join(newline);
  const md = createDocsMarkdown();
  const document = parseDocsDocument(source, md, {
    mapLink: (href: string, line: number | undefined) => ({ href, line }),
  });
  expect(document.links).toEqual([{ href: "/same", line: 7 }]);
  expect(md.renderer.render(document.tokens, md.options, document.env)).toContain(
    "&lt;Card href=&quot;/same&quot; title=&quot;Literal&quot; /&gt;",
  );
});

it.each([
  {
    name: "published possessive links",
    source: "## Request today's summary\n\n## The vendor's harness, as a plugin",
    headings: [
      ["request-today's-summary", "request-todays-summary"],
      ["the-vendor's-harness%2C-as-a-plugin", "the-vendors-harness-as-a-plugin"],
    ],
    collisions: [],
  },
  {
    name: "normalized duplicates and numbered suffixes before alias reservation",
    source: "## A-s\n\n## As\n\n## A-s\n\n## A-s-2\n\n## A-s",
    headings: [
      ["a-s", null],
      ["as", "as-2"],
      ["a-s-1", "as-3"],
      ["a-s-2", "as-2-1"],
      ["a-s-3", "as-4"],
    ],
    collisions: [{ id: "as", reason: "compatibility alias collision" }],
  },
  {
    name: "percent bytes, underscores and numbered title prefixes",
    source:
      "## café 中文 _Über\n\n## café 中文 _Über\n\n## 1. Today\n\n## 1. Today\n\n## 100% ready",
    headings: [
      ["caf%C3%A9-%E4%B8%AD%E6%96%87-_%C3%BCber", "café-中文-_über"],
      ["caf%C3%A9-%E4%B8%AD%E6%96%87-_%C3%BCber-1", "café-中文-_über-2"],
      ["1.-today", "1-today"],
      ["1.-today-1", "1-today-2"],
      ["100%25-ready", "100%-ready"],
    ],
    collisions: [],
  },
])("preserves Mint heading targets for $name", ({ source, headings, collisions }) => {
  const document = parseDocsDocument(source);
  expect(
    document.tokens
      .filter((token) => token.type === "heading_open")
      .map((token) => [token.attrGet("id"), token.meta?.anchorAlias ?? null]),
  ).toEqual(headings);
  expect(document.collisions).toEqual(collisions);
  expect(new Set(document.ids).size).toBe(document.ids.length);
});

it.each([
  {
    name: "shared heading/Step TOC with an independent Tab counter",
    source: [
      "## Today's summary",
      '<Steps titleSize="h2">',
      '<Step title="Today\'s summary">one</Step>',
      '<Step title="Today\'s summary">two</Step>',
      "</Steps>",
      "<Tabs>",
      '<Tab title="Today\'s summary">one</Tab>',
      '<Tab title="Todays summary">two</Tab>',
      '<Tab title="Today\'s summary">three</Tab>',
      "</Tabs>",
      '<Accordion title="A-s">one</Accordion>',
      '<Accordion title="As">two</Accordion>',
      '<ParamField body="a-s">one</ParamField>',
      '<ResponseField name="as">two</ResponseField>',
    ],
    ids: "today's-summary todays-summary todays-summary-2 todays-summary-3 todays-summary-1 todays-summary-2-1 todays-summary-3-1 as as-1 param-as param-as-1".split(
      " ",
    ),
    collisions: [],
  },
  {
    name: "authored IDs reserved before heading aliases and component IDs",
    source: [
      "## Today's summary",
      '<a id="todays-summary"></a>',
      '<Tab title="A-s">one</Tab>',
      '<Tab id="as" title="Explicit">two</Tab>',
      '<Accordion title="A-s">three</Accordion>',
      '<ParamField body="a-s">four</ParamField>',
      '<a id="param-as"></a>',
    ],
    ids: ["today's-summary", "todays-summary", "as", "param-as", "as-1", "as-2", "param-as-1"],
    collisions: [{ id: "todays-summary", reason: "compatibility alias collision" }],
  },
  {
    name: "raw component apostrophes normalized after separators",
    source: [
      '<Accordion title="A-s\'s guide">one</Accordion>',
      '<ParamField body="a-s\'sGuide">two</ParamField>',
    ],
    ids: ["as-s-guide", "param-as-s-guide"],
    collisions: [],
  },
])("preserves Mint component targets for $name", ({ source, ids, collisions }) => {
  const document = parseDocsDocument(source.join("\n\n"));
  expect(document.ids).toEqual(ids);
  expect(document.collisions).toEqual(collisions);
  expect(new Set(document.ids).size).toBe(document.ids.length);
});

it.each<AuditCliCase>([
  {
    name: "component and list fences",
    source: lines(
      "<Accordion>\n    ~~~md\n    [example](/hidden-tilde)\n    ~~~not-a-closing-fence",
      "    [example](/hidden-after-false-close)\n    ~~~\n</Accordion>\n",
      "- Example\n\n    ````md\n    ```text\n    [example](/hidden-nested)\n    ```\n    ````\n",
      "[real](/missing-page)\n[valid](/page)",
    ),
    broken: 1,
  },
  {
    name: "legacy malformed MDX",
    source: lines(
      "<!doctype html>\n~~~md\n[example](/hidden-fallback)\n~~~\n[real](/missing-page)\n[valid](/page)",
    ),
    broken: 1,
  },
  {
    name: "indented component prose",
    source: ["<Accordion>", "    [real](/missing-page)", "</Accordion>", "[valid](/page)"],
    broken: 1,
  },
  { name: "valid prose", source: ["[valid](/page)"], broken: 0 },
  ...[false, true].map((anchors) => ({
    name: `fenced raw HTML boundaries (anchors=${anchors})`,
    anchors,
    source: lines(
      "```html\n\n<code>\n```\n",
      '<ParamField path="live" type="string">\n[Visible](/missing-page)\n</ParamField>\n',
      "```html\n</code>\n```\n\n[valid](/page)",
    ),
    broken: 1,
    diagnostics: ["page.mdx:7 :: /missing-page :: route/file not found"],
  })),
  {
    name: "repeated occurrences beside protected literals",
    source: lines(
      "---\ntitle: Positions\n---\n```md\n[hidden](/missing-page)\n```",
      "[first](/missing-page)\n[second](/missing-page)\n",
      "`[hidden](/missing-page)` [third](/missing-page)\n[valid](/page)",
    ),
    broken: 3,
    diagnostics: [7, 8, 10].map(
      (line) => `page.mdx:${line} :: /missing-page :: route/file not found`,
    ),
  },
  {
    name: "reference, HTML, component and normalized relative occurrences",
    source: lines(
      "[reference][missing]\n\n[missing]: /missing-page\n",
      '<a href="/missing-page">HTML</a>\n\n<Card href="/missing-page" title="Component" />\n',
      "[relative](./missing-page.md)\n[valid](/page)",
    ),
    broken: 4,
    diagnostics: [1, 5, 7, 9].map(
      (line) => `page.mdx:${line} :: /missing-page :: route/file not found`,
    ),
  },
  {
    name: "unmapped expansions",
    source: lines(
      '<Snippet file="./part.txt" />\n',
      '<div class="maturity-category-docs">\n[embedded](/missing-page)\n</div>\n\n[valid](/page)',
    ),
    files: { "docs/part.txt": "[included](/missing-page)\n" },
    broken: 2,
    diagnostics: ["page.mdx:unknown :: /missing-page :: route/file not found"],
  },
  {
    name: "decoded direct paths and HTML-alias targets",
    anchors: true,
    source: [
      "[direct](/caf%C3%A9#known)",
      "[literal percent](/100%25#known)",
      "[asset](/image%20space.svg)",
      "[redirect](/via)",
      "[bad redirect](/invalid)",
      "[raw Markdown redirect](/raw)",
      "[after](/missing-page)",
      "[external](/outside)",
    ],
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
    broken: 4,
    diagnostics: [
      "docs.json:unknown :: /invalid :: malformed URL path",
      "page.mdx:5 :: /invalid :: malformed URL path",
      "page.mdx:6 :: /raw :: fragment requires an HTML page, not raw Markdown",
      "page.mdx:7 :: /missing-page :: route/file not found",
    ],
  },
  ...[false, true].map((anchors) => ({
    name: `malformed emitted paths (anchors=${anchors})`,
    anchors,
    source: lines(
      '<Card href="/bad%" title="Component" />\n\n<a href="/bad%FF">HTML</a>\n',
      '<img src="/bad%2" />\n\n<CTA primaryHref="/bad%zz" secondaryHref="https://docs.openclaw.ai/bad%" />\n',
      "[markdown](/bad%FF)\n[reference][bad]\n\n[bad]: /bad%FF\n",
      "[after](/missing-page)\n[valid](/page)",
    ),
    broken: anchors ? 8 : 7,
    diagnostics: [
      ":: /bad% :: malformed URL path",
      ":: /bad%FF :: malformed URL path",
      ":: /missing-page :: route/file not found",
    ],
  })),
  ...[false, true].map((anchors) => ({
    name: `unpublished permalink routes (anchors=${anchors})`,
    anchors,
    source: lines(
      "---\npermalink: /unpublished\n---\n[unpublished](/unpublished)",
      '[fragment](/unpublished#connection)\n[valid](/page#connection)\n<a id="connection" />',
    ),
    navigation: ["unpublished"],
    broken: 3,
    diagnostics: [
      "page.mdx:4 :: /unpublished :: route/file not found",
      "page.mdx:5 :: /unpublished#connection :: route/file not found",
      "docs.json:unknown :: unpublished :: navigation page not published",
    ],
  })),
  {
    name: "shared emitted fragments",
    anchors: true,
    broken: 4,
    source: [
      '## agents.defaults.cwd\n\n<Accordion title="Connect" id="connection">\n\n## Nested\n\n</Accordion>\n',
      "[legacy](#agents-defaults-cwd)",
      "[canonical](#agents.defaults.cwd)",
      "[component](#connection)",
      "[nested](https://docs.openclaw.ai/page#nested)",
      "[absent](#missing)",
      "[relative](./page.mdx#connection)",
      "[raw Markdown](/page.md#connection)",
      "[root](/#root)",
      "[missing root alias](/index#missing)",
      "[unpublished permalink](/unpublished#connection)",
      "[dropped incoming fragment](/drops#missing)",
      "[redirect](/legacy#wrong-incoming-fragment)",
      "[chain](/middle#also-wrong)",
      "[reference][ref]\n\n[ref]: /page#connection\n\n```md\n## Phantom\n[hidden](/hidden-code)\n```",
      '<!-- <a id="phantom" href="/hidden-comment"> -->',
    ].flatMap((block) => block.split("\n")),
  },
])(
  "audits real CLI links after $name",
  ({ source, broken, anchors = false, diagnostics, files = {}, navigation = [], redirects }) => {
    const fixtureRoot = tempDirs.make("docs-link-audit-cli-");
    const docsRoot = path.join(fixtureRoot, "docs");
    const clawHubRoot = path.join(fixtureRoot, "clawhub");
    fs.mkdirSync(docsRoot);
    fs.mkdirSync(path.join(clawHubRoot, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(docsRoot, "docs.json"),
      JSON.stringify({
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
      }),
    );
    writeFiles(fixtureRoot, files);
    if (anchors) {
      fs.writeFileSync(path.join(docsRoot, "index.md"), "## Root\n\n[next](next#target)\n");
      fs.writeFileSync(path.join(docsRoot, "next.md"), "## Target\n");
    }
    const pageSource =
      anchors && !diagnostics ? ["---", "permalink: /unpublished", "---", ...source] : source;
    fs.writeFileSync(path.join(docsRoot, "page.mdx"), `${pageSource.join("\n")}\n`);

    const result = runAuditCli(fixtureRoot, { anchors, clawHubRoot });
    expect(result.error).toBeUndefined();
    expect(result, result.stdout).toMatchObject({
      stderr: "",
      status: broken ? 1 : 0,
    });
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
        `page.mdx:${source.findIndex((line) => line.includes("/missing-page")) + 1} :: /missing-page :: route/file not found`,
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
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(docsRoot, "docs.json"),
      JSON.stringify({
        navigation: [{ group: "ClawHub", pages: ["clawhub/index", "clawhub/publishing"] }],
        redirects: options.redirects ?? [{ source: "/tools/clawhub", destination: "/clawhub" }],
      }),
    );
    fs.writeFileSync(path.join(docsRoot, "page.md"), `## Page\n\n[hub](${link})\n`);
    return docsRoot;
  };

  const fragment = "/clawhub/publishing#package-publish-source";
  const redirected = { redirects: [{ source: "/tools/clawhub", destination: fragment }] };
  function auditMirror(
    link: string,
    options: { anchors?: boolean; allowExternalClawHubRoutes?: boolean; redirect?: boolean } = {},
  ) {
    const { redirect = false, ...auditOptions } = options;
    return auditDocsLinks({
      docsDir: buildDocsTree(link, redirect ? redirected : {}),
      allowExternalClawHubRoutes: true,
      anchors: true,
      ...auditOptions,
    });
  }

  function expectUnverified(result: ReturnType<typeof auditDocsLinks>) {
    expect(result.unverifiedMirroredFragments).toBe(1);
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]?.reason).toContain("fragment unverified");
    expect(result.broken[0]?.reason).toContain("OPENCLAW_DOCS_SYNC_CLAWHUB_REPO");
  }

  it("reports fragments into mirrored routes as unverified rather than missing", () => {
    expectUnverified(auditMirror(fragment));
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

  it("reports unverified fragments in redirect destinations into mirrored routes", () => {
    const result = auditMirror("/page", { redirect: true });
    expectUnverified(result);
    expect(result.broken[0]).toMatchObject({ file: "docs.json", link: "/tools/clawhub" });
  });

  it("keeps mirrored redirect destinations silent in plain mode", () => {
    const result = auditMirror("/page", { redirect: true, anchors: false });
    expect(result).toMatchObject({ broken: [], unverifiedMirroredFragments: 0 });
  });

  it("still reports undeclared routes under /clawhub as missing", () => {
    const result = auditMirror("/clawhub/not-in-navigation");
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]?.reason).toContain("route/file not found");
  });

  it("does not accept mirrored routes when the allowance is off", () => {
    const result = auditMirror("/clawhub/publishing", { allowExternalClawHubRoutes: false });
    expect(result.broken.some((item) => item.reason.includes("route/file not found"))).toBe(true);
  });
});

it("prepares every external-link input without exposing code literals", () => {
  const fixtureRoot = tempDirs.make("docs-external-link-audit-");
  const docsRoot = path.join(fixtureRoot, "docs");
  const source = [
    '<AccordionGroup>\n  <Accordion title="Reasoning">',
    "    [reasoning](https://docs.example.test/reasoning)",
    "    `https://api.example.test/v1`",
    "    ````markdown\n    ```text\n    <CODE_PLACEHOLDER>\n    ```",
    "    ~~~\n    [code literal](https://code.example.test)\n    ~~~\n    ````",
    '    - ```html\n      <script src="https://code.example.test/list-fence">\n      ```',
    "      [after list fence](https://docs.example.test/after-list-fence)",
    "    ```text\n    - ```\n    <Accordion>\n    [fenced component](https://code.example.test/fenced-component)\n    ```",
    "    [after literal list fence](https://docs.example.test/after-literal-list-fence)",
    "  </Accordion>\n</AccordionGroup>",
    "<Link>\n    [component link](https://docs.example.test/component)\n</Link>",
    "<Pre>\n    [pre component](https://docs.example.test/pre-component)\n</Pre>",
    "[after code block](https://docs.example.test/after-code-block)",
    "[after indented code](https://docs.example.test/after-indented-code)",
    "[after script](https://docs.example.test/after-script)",
    "[after void](https://docs.example.test/after-void)",
    "[reference][shared]",
    "",
    "[shared]: https://docs.example.test/reference-first?one=1&two=2",
    "[shared]: https://docs.example.test/reference-second",
    "![image](https://docs.example.test/image.png?one=1&two=2)",
    "`<PROVIDER>_API_KEY=...`",
    "",
  ].join("\n");
  fs.mkdirSync(path.join(docsRoot, "providers"), { recursive: true });
  fs.writeFileSync(path.join(docsRoot, "providers", "example.md"), source, "utf8");
  for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    fs.writeFileSync(
      path.join(fixtureRoot, filename),
      `<div>\n  [${filename}](https://root.test)\n</div>\n`,
    );
  }

  const outputRoot = path.join(fixtureRoot, ".audit");
  expect(prepareExternalLinkAuditTree(fixtureRoot, outputRoot)).toEqual({
    files: 4,
    projectedLinks: 14,
  });
  const prepared = fs.readFileSync(
    path.join(outputRoot, "docs", "providers", "example.md"),
    "utf8",
  );
  const preparedLines = prepared.split("\n");
  expect(preparedLines).toHaveLength(source.split("\n").length);
  expect(preparedLines[2]).toContain('href="https://docs.example.test/reasoning"');
  for (const url of [
    "https://docs.example.test/after-list-fence",
    "https://docs.example.test/after-literal-list-fence",
    "https://docs.example.test/component",
    "https://docs.example.test/pre-component",
    "https://docs.example.test/after-code-block",
    "https://docs.example.test/after-indented-code",
    "https://docs.example.test/after-script",
    "https://docs.example.test/after-void",
  ]) {
    expect(prepared).toContain(`href="${url}"`);
  }
  expect(prepared).toContain('href="https://docs.example.test/reference-first?one=1&amp;two=2"');
  expect(prepared).toContain('href="https://docs.example.test/image.png?one=1&amp;two=2"');
  for (const url of [
    "https://api.example.test/v1",
    "https://code.example.test",
    "https://code.example.test/list-fence",
    "https://code.example.test/fenced-component",
    "https://docs.example.test/reference-second",
  ]) {
    expect(prepared).not.toContain(url);
  }
  for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    expect(fs.readFileSync(path.join(outputRoot, filename), "utf8")).toContain(
      'href="https://root.test"',
    );
  }
});

it("falls back to tolerant parsing for legacy malformed MDX", () => {
  const fixtureRoot = tempDirs.make("docs-external-link-fallback-");
  fs.mkdirSync(path.join(fixtureRoot, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, "docs", "legacy.md"),
    "<!doctype html>\n<pre>\n[hidden](https://hidden.example.test)\n</pre>\n<Note>\ntext <code>[inline hidden](https://same.example.test)</code> [inline real](https://same.example.test)\n[legacy](https://legacy.example.test)\n</Note>\n<Pre>\n[component](https://component.example.test)\n</Pre>\n[reference][legacy-ref]\n\n[legacy-ref]: https://reference.example.test\n<style><code>[style hidden](https://style.example.test)</code></style> [style real](https://style.example.test)\n```html\n<code>\n[fenced hidden](https://fenced-hidden.example.test)\n```\n<Note>\n[after fence](https://after-fence.example.test)\n</Note>\n",
  );
  for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    fs.writeFileSync(path.join(fixtureRoot, filename), "");
  }

  const outputRoot = path.join(fixtureRoot, ".audit");
  expect(prepareExternalLinkAuditTree(fixtureRoot, outputRoot)).toEqual({
    files: 4,
    projectedLinks: 6,
  });
  const prepared = fs.readFileSync(path.join(outputRoot, "docs", "legacy.md"), "utf8").split("\n");
  expect(prepared[6]).toContain('href="https://legacy.example.test"');
  expect(prepared[5]?.match(/https:\/\/same\.example\.test/g)).toHaveLength(1);
  expect(prepared[9]).toContain('href="https://component.example.test"');
  expect(prepared[11]).toContain('href="https://reference.example.test"');
  expect(prepared[14]?.match(/https:\/\/style\.example\.test/g)).toHaveLength(1);
  expect(prepared[20]).toContain('href="https://after-fence.example.test"');
  expect(prepared.join("\n")).not.toContain("https://hidden.example.test");
  expect(prepared.join("\n")).not.toContain("https://fenced-hidden.example.test");
});

it("does not create mirrored docs copies for non-root docs trees", () => {
  const fixtureRoot = tempDirs.make("docs-link-audit-mirror-");
  const docsRoot = path.join(fixtureRoot, "docs");
  fs.mkdirSync(docsRoot, { recursive: true });

  const before = tempEntries("openclaw-docs-link-audit-");
  const mirroredDocsDir = prepareMirroredDocsDir(docsRoot);
  expect(mirroredDocsDir).toEqual({
    cleanup: expect.any(Function),
    dir: path.resolve(docsRoot),
    mirroredClawHub: false,
  });
  mirroredDocsDir.cleanup();
  const after = tempEntries("openclaw-docs-link-audit-");
  expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
});

it("cleans mirrored docs copies when ClawHub sync fails", () => {
  const before = tempEntries("openclaw-docs-link-audit-");

  expect(() =>
    prepareMirroredDocsDir(undefined, {
      resolveClawHubRepoPathImpl() {
        return path.join(os.tmpdir(), "clawhub-docs");
      },
      syncClawHubDocsTreeImpl() {
        throw new Error("sync failed");
      },
    }),
  ).toThrow("sync failed");

  const after = tempEntries("openclaw-docs-link-audit-");
  expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
});
