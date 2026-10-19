import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const script = path.resolve(import.meta.dirname, "../../scripts/docs-mirror-freshness.mjs");
const syncWorkflow = readFileSync(
  path.resolve(import.meta.dirname, "../../.github/workflows/docs-sync-publish.yml"),
  "utf8",
);
const baseSha = "a".repeat(40);
const oldSha = "b".repeat(40);
const newestSha = "c".repeat(40);
const excludedSha = "d".repeat(40);
const instructions = "docs/AGENTS.md";
const translations = "docs/.i18n/README.md";
const guide = "docs/guide.md";
const commit = (sha: string, minutes: number): Commit => ({ sha, minutes });
const baseCommit = { sha: baseSha, minutes: 360 };
type CommitFile = { filename: string; previous_filename?: string };
type Commit = { sha: string; minutes: number };
type Scenario = {
  mirror?: string;
  history?: Record<string, Commit[]>;
  files?: Record<string, CommitFile[] | null>;
  workflow?: string;
  grace?: number;
  active?: number;
};
type Request = { method: string; pathname: string; search: string };
const commitFiles = (...filenames: string[]): CommitFile[] =>
  filenames.map((filename) => ({ filename }));

function runScenario(options: Scenario) {
  const scenario = { mirror: baseSha, history: {}, grace: 60, active: 0, files: {}, ...options };
  const root = createTempDir("openclaw-docs-mirror-");
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  writeFileSync(
    path.join(root, ".github/workflows/docs-sync-publish.yml"),
    scenario.workflow ??
      "on:\n  push:\n    paths:\n      - watched-docs/**\n      - scripts/publish-support.mjs\n",
  );
  const requestsPath = path.join(root, "requests.jsonl");
  writeFileSync(requestsPath, "");
  const preload = path.join(root, "github-fixture.mjs");
  writeFileSync(
    preload,
    String.raw`import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const rejectNetwork = () => { throw new Error("Unexpected network connection"); };
net.connect = net.createConnection = net.Socket.prototype.connect = rejectNetwork;
syncBuiltinESMExports();
const scenario = JSON.parse(process.env.OPENCLAW_DOCS_TEST_SCENARIO);
const now = Date.parse("2026-09-09T12:00:00Z");
Date.now = () => now;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const method = init.method ?? "GET";
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(new Headers(init.headers).has("authorization"), false);
  fs.appendFileSync(process.env.OPENCLAW_DOCS_TEST_REQUESTS, JSON.stringify({ method, pathname: url.pathname, search: url.search }) + "\n");
  let body;
  if (method === "GET" && url.pathname === "/repos/openclaw/openclaw/commits") {
    assert.equal(url.searchParams.get("sha"), "main");
    const watchedPath = url.searchParams.get("path");
    assert.ok(!watchedPath.startsWith("!") && !/['"]/.test(watchedPath), "query positive unquoted paths only");
    const perPage = Number(url.searchParams.get("per_page"));
    const page = Number(url.searchParams.get("page") ?? 1);
    assert.ok(perPage >= 1 && perPage <= 100 && page >= 1);
    const until = url.searchParams.get("until");
    if (until) assert.equal(Date.parse(until), now - scenario.grace * 60000);
    const entries = (scenario.history[watchedPath] ?? [])
      .map(entry => ({ sha: entry.sha, commit: { committer: { date: new Date(now - entry.minutes * 60000).toISOString() } } }))
      .filter(entry => !until || Date.parse(entry.commit.committer.date) <= Date.parse(until));
    body = entries.slice((page - 1) * perPage, page * perPage);
  } else if (method === "GET" && /^\/repos\/openclaw\/openclaw\/commits\/[a-f0-9]{40}$/.test(url.pathname)) {
    assert.equal(url.searchParams.get("per_page"), "100");
    const sha = url.pathname.split("/").at(-1);
    assert.ok(Object.hasOwn(scenario.files, sha), "unexpected commit inspection: " + sha);
    body = scenario.files[sha] === null ? { sha } : { sha, files: scenario.files[sha] };
  } else if (method === "GET" && url.pathname === "/repos/openclaw/docs/contents/.openclaw-sync/source.json") {
    assert.equal(url.searchParams.get("ref"), "main");
    body = { content: Buffer.from(JSON.stringify({ sha: scenario.mirror })).toString("base64") };
  } else if (method === "GET" && url.pathname.startsWith("/repos/openclaw/openclaw/compare/")) {
    const [from, to] = url.pathname.split("/").at(-1).split("...");
    const order = scenario.ancestry;
    assert.ok(order.includes(from) && order.includes(to));
    body = { status: from === to ? "identical" : order.indexOf(to) > order.indexOf(from) ? "ahead" : "behind" };
  } else if (method === "GET" && url.pathname === "/repos/openclaw/openclaw/actions/workflows/docs-sync-publish.yml/runs") {
    assert.equal(url.searchParams.get("per_page"), "1");
    assert.ok(["queued", "in_progress"].includes(url.searchParams.get("status")));
    body = { total_count: url.searchParams.get("status") === "queued" ? scenario.active : 0 };
  } else if (method === "POST" && url.pathname === "/repos/openclaw/openclaw/actions/workflows/docs-sync-publish.yml/dispatches") {
    assert.deepEqual(JSON.parse(init.body), { ref: "main" });
    return new Response(null, { status: 204 });
  } else {
    throw new Error("Unexpected GitHub request: " + method + " " + url.pathname);
  }
  return Response.json(body);
};
`,
  );
  const result = spawnSync(process.execPath, ["--import", preload, script], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      DOCS_MIRROR_STALE_MINUTES: String(scenario.grace),
      OPENCLAW_DOCS_TEST_REQUESTS: requestsPath,
      OPENCLAW_DOCS_TEST_SCENARIO: JSON.stringify({
        ...scenario,
        ancestry: [baseSha, oldSha, newestSha],
      }),
    },
  });
  expect(result.error).toBeUndefined();
  const lines = readFileSync(requestsPath, "utf8").trim();
  const requests: Request[] = lines ? lines.split("\n").map((line) => JSON.parse(line)) : [];
  return { result, requests };
}

function expectRecovery(run: ReturnType<typeof runScenario>, stale: boolean, sha = newestSha) {
  expect(run.result.status, run.result.stdout + run.result.stderr).toBe(stale ? 1 : 0);
  expect(run.requests.filter((request) => request.method === "POST")).toHaveLength(stale ? 1 : 0);
  expect(stale ? run.result.stderr : run.result.stdout).toContain(sha);
}
function runDocs(commits: Commit[], files: NonNullable<Scenario["files"]>, inspectBase = true) {
  return runScenario({
    workflow: syncWorkflow,
    history: { docs: [...commits, baseCommit] },
    files: { ...(inspectBase ? { [baseSha]: commitFiles(guide) } : {}), ...files },
  });
}

it.each<[string, string, number, boolean, boolean, number, number, number]>([
  ["a current mirror", newestSha, 10, true, true, 60, 0, 0],
  ["an overdue change hidden by a recent edit", baseSha, 10, true, true, 60, 0, 120],
  ["an overdue change with recovery already active", baseSha, 10, true, true, 60, 1, 120],
  ["a quiet stale source", baseSha, 90, true, true, 60, 0, 90],
  ["the first watched change still in grace", baseSha, 10, false, false, 60, 0, 0],
  ["a configured longer grace period", baseSha, 10, true, true, 180, 0, 0],
  ["a change just inside the grace boundary", oldSha, 59.75, true, true, 60, 0, 0],
])(
  "handles %s without live network access",
  (_name, mirror, recentMinutes, old, base, grace, active, staleMinutes) => {
    const earlier = base ? [baseCommit] : [];
    const run = runScenario({
      mirror,
      grace,
      active,
      history: {
        "watched-docs": [commit(newestSha, recentMinutes), ...earlier],
        "scripts/publish-support.mjs": [...(old ? [commit(oldSha, 120)] : []), ...earlier],
      },
    });
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(staleMinutes ? 1 : 0);
    expect(run.requests.filter((request) => request.method === "POST")).toHaveLength(
      staleMinutes && !active ? 1 : 0,
    );
    if (staleMinutes) {
      expect(run.result.stderr).toContain("docs mirror stale for " + staleMinutes + "m");
      expect(run.result.stderr).toContain(recentMinutes === staleMinutes ? newestSha : oldSha);
    } else {
      expect(run.result.stdout).toContain(
        mirror === newestSha ? "docs mirror fresh:" : "within " + grace + "m grace",
      );
    }
    expect(run.requests.some((request) => /\/commits\/[a-f0-9]{40}$/.test(request.pathname))).toBe(
      false,
    );
  },
);

it.each<[string, CommitFile[] | null, boolean]>([
  ["authoring instructions", commitFiles(instructions), false],
  ["translation instructions", commitFiles(translations), false],
  [
    "both excluded files and unrelated code",
    commitFiles(instructions, translations, "src/index.ts"),
    false,
  ],
  ["a mixed public-docs change", commitFiles(instructions, guide), true],
  ["the public AGENTS template", commitFiles("docs/reference/templates/AGENTS.md"), true],
  [
    "a public page renamed to an excluded file",
    [{ filename: instructions, previous_filename: guide }],
    true,
  ],
  ["an unavailable file inventory", null, true],
  ["an empty file inventory", [], true],
  [
    "a full page that may omit a public file",
    commitFiles(...Array.from({ length: 100 }, (_, index) => "src/file-" + index + ".ts")),
    true,
  ],
])("handles %s using the publish workflow's paths", (_name, files, stale) => {
  const run = runDocs([commit(newestSha, 90)], { [newestSha]: files });
  expectRecovery(run, stale, stale ? newestSha : baseSha);
});

it("continues past a full page of excluded commits", () => {
  const excluded = Array.from({ length: 100 }, (_, index) => ({
    sha: (index + 4096).toString(16).padStart(40, "0"),
    minutes: 90 + index,
  }));
  const run = runDocs(
    excluded,
    Object.fromEntries(excluded.map((entry) => [entry.sha, commitFiles(instructions)])),
  );
  expectRecovery(run, false, baseSha);
  expect(
    run.requests.some(
      (request) =>
        request.pathname.endsWith("/commits") &&
        new URLSearchParams(request.search).get("page") === "2",
    ),
  ).toBe(true);
});

it.each([false, true])("skips excluded edits (grace-cutoff lookup: %s)", (cutoff) => {
  const run = runDocs(
    [
      ...(cutoff ? [commit(newestSha, 10)] : []),
      commit(excludedSha, cutoff ? 90 : 10),
      commit(oldSha, 120),
    ],
    {
      ...(cutoff ? { [newestSha]: commitFiles("docs/new-guide.md") } : {}),
      [excludedSha]: commitFiles(cutoff ? translations : instructions),
      [oldSha]: commitFiles(guide),
    },
    false,
  );
  expectRecovery(run, true, oldSha);
});

it("honors a later exact-file inclusion after an exclusion", () => {
  const run = runScenario({
    workflow:
      "on:\n  push:\n    paths:\n      - docs/**\n      - \"!docs/AGENTS.md\"\n      - 'docs/AGENTS.md'\n",
    history: {
      docs: [commit(newestSha, 90)],
      [instructions]: [commit(newestSha, 90)],
    },
    files: { [newestSha]: commitFiles(instructions) },
  });
  expectRecovery(run, true);
});

it.each(["!docs/**", "docs/*.md"])("rejects unsupported filter %s", (filter) => {
  const run = runScenario({
    workflow: 'on:\n  push:\n    paths:\n      - docs/**\n      - "' + filter + '"\n',
  });
  expect(run.result.status).toBe(1);
  expect(run.result.stderr).toContain("unsupported glob in sync path filter");
  expect(run.requests).toHaveLength(0);
});
