import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
const baseCommit = { sha: baseSha, minutes: 360 };
type CommitFile = { filename: string; previous_filename?: string };
type Scenario = {
  mirror: string;
  history: Record<string, { sha: string; minutes: number }[]>;
  files?: Record<string, CommitFile[] | null>;
  workflow?: string;
  grace?: number;
  active?: number;
};
type Request = { method: string; pathname: string; search: string };

function runScenario(scenario: Scenario) {
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
      DOCS_MIRROR_STALE_MINUTES: String(scenario.grace ?? 60),
      OPENCLAW_DOCS_TEST_REQUESTS: requestsPath,
      OPENCLAW_DOCS_TEST_SCENARIO: JSON.stringify({
        ...scenario,
        grace: scenario.grace ?? 60,
        active: scenario.active ?? 0,
        files: scenario.files ?? {},
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

describe("docs mirror freshness", () => {
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
          "watched-docs": [{ sha: newestSha, minutes: recentMinutes }, ...earlier],
          "scripts/publish-support.mjs": [
            ...(old ? [{ sha: oldSha, minutes: 120 }] : []),
            ...earlier,
          ],
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
      expect(
        run.requests.some((request) => /\/commits\/[a-f0-9]{40}$/.test(request.pathname)),
      ).toBe(false);
    },
  );

  it.each<{ name: string; files: CommitFile[] | null; stale: boolean }>([
    { name: "authoring instructions", files: [{ filename: "docs/AGENTS.md" }], stale: false },
    {
      name: "translation instructions",
      files: [{ filename: "docs/.i18n/README.md" }],
      stale: false,
    },
    {
      name: "both excluded files and unrelated code",
      files: [
        { filename: "docs/AGENTS.md" },
        { filename: "docs/.i18n/README.md" },
        { filename: "src/index.ts" },
      ],
      stale: false,
    },
    {
      name: "a mixed public-docs change",
      files: [{ filename: "docs/AGENTS.md" }, { filename: "docs/guide.md" }],
      stale: true,
    },
    {
      name: "the public AGENTS template",
      files: [{ filename: "docs/reference/templates/AGENTS.md" }],
      stale: true,
    },
    {
      name: "a public page renamed to an excluded file",
      files: [{ filename: "docs/AGENTS.md", previous_filename: "docs/guide.md" }],
      stale: true,
    },
    { name: "an unavailable file inventory", files: null, stale: true },
    { name: "an empty file inventory", files: [], stale: true },
    {
      name: "a full page that may omit a public file",
      files: Array.from({ length: 100 }, (_, index) => ({ filename: "src/file-" + index + ".ts" })),
      stale: true,
    },
  ])("handles $name using the publish workflow's paths", ({ files, stale }) => {
    const run = runScenario({
      workflow: syncWorkflow,
      mirror: baseSha,
      history: { docs: [{ sha: newestSha, minutes: 90 }, baseCommit] },
      files: {
        [newestSha]: files,
        [baseSha]: [{ filename: "docs/guide.md" }],
      },
    });
    expectRecovery(run, stale, stale ? newestSha : baseSha);
  });

  it("continues past a full page of excluded commits", () => {
    const excluded = Array.from({ length: 100 }, (_, index) => ({
      sha: (index + 4096).toString(16).padStart(40, "0"),
      minutes: 90 + index,
    }));
    const run = runScenario({
      workflow: syncWorkflow,
      mirror: baseSha,
      history: { docs: [...excluded, baseCommit] },
      files: {
        ...Object.fromEntries(
          excluded.map((commit) => [commit.sha, [{ filename: "docs/AGENTS.md" }]]),
        ),
        [baseSha]: [{ filename: "docs/guide.md" }],
      },
    });
    expectRecovery(run, false, baseSha);
    expect(
      run.requests.some(
        (request) =>
          request.pathname.endsWith("/commits") &&
          new URLSearchParams(request.search).get("page") === "2",
      ),
    ).toBe(true);
  });

  it("does not let a recent excluded edit hide an overdue public change", () => {
    const run = runScenario({
      workflow: syncWorkflow,
      mirror: baseSha,
      history: {
        docs: [{ sha: excludedSha, minutes: 10 }, { sha: oldSha, minutes: 120 }, baseCommit],
      },
      files: {
        [excludedSha]: [{ filename: "docs/AGENTS.md" }],
        [oldSha]: [{ filename: "docs/guide.md" }],
      },
    });
    expectRecovery(run, true, oldSha);
  });

  it("skips excluded edits during the grace-cutoff lookup too", () => {
    const run = runScenario({
      workflow: syncWorkflow,
      mirror: baseSha,
      history: {
        docs: [
          { sha: newestSha, minutes: 10 },
          { sha: excludedSha, minutes: 90 },
          { sha: oldSha, minutes: 120 },
          baseCommit,
        ],
      },
      files: {
        [newestSha]: [{ filename: "docs/new-guide.md" }],
        [excludedSha]: [{ filename: "docs/.i18n/README.md" }],
        [oldSha]: [{ filename: "docs/guide.md" }],
      },
    });
    expectRecovery(run, true, oldSha);
  });

  it("honors a later exact-file inclusion after an exclusion", () => {
    const run = runScenario({
      workflow:
        "on:\n  push:\n    paths:\n      - docs/**\n      - \"!docs/AGENTS.md\"\n      - 'docs/AGENTS.md'\n",
      mirror: baseSha,
      history: {
        docs: [{ sha: newestSha, minutes: 90 }],
        "docs/AGENTS.md": [{ sha: newestSha, minutes: 90 }],
      },
      files: { [newestSha]: [{ filename: "docs/AGENTS.md" }] },
    });
    expectRecovery(run, true);
  });

  it.each(["!docs/**", "docs/*.md"])("rejects unsupported filter %s", (filter) => {
    const run = runScenario({
      workflow: 'on:\n  push:\n    paths:\n      - docs/**\n      - "' + filter + '"\n',
      mirror: baseSha,
      history: {},
    });
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("unsupported glob in sync path filter");
    expect(run.requests).toHaveLength(0);
  });
});
