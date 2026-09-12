import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const script = path.resolve(import.meta.dirname, "../../scripts/docs-mirror-freshness.mjs");
const baseSha = "a".repeat(40);
const oldSha = "b".repeat(40);
const newestSha = "c".repeat(40);

describe("docs mirror freshness", () => {
  it.each([
    {
      name: "a current mirror",
      mirror: newestSha,
      recentMinutes: 10,
      old: true,
      base: true,
      grace: 60,
      active: 0,
      staleMinutes: 0,
    },
    {
      name: "only recent changes",
      mirror: baseSha,
      recentMinutes: 10,
      old: false,
      base: true,
      grace: 60,
      active: 0,
      staleMinutes: 0,
    },
    {
      name: "an overdue change hidden by a recent edit",
      mirror: baseSha,
      recentMinutes: 10,
      old: true,
      base: true,
      grace: 60,
      active: 0,
      staleMinutes: 120,
    },
    {
      name: "an overdue change with recovery already active",
      mirror: baseSha,
      recentMinutes: 10,
      old: true,
      base: true,
      grace: 60,
      active: 1,
      staleMinutes: 120,
    },
    {
      name: "a quiet stale source",
      mirror: baseSha,
      recentMinutes: 90,
      old: true,
      base: true,
      grace: 60,
      active: 0,
      staleMinutes: 90,
    },
    {
      name: "the first watched change still in grace",
      mirror: baseSha,
      recentMinutes: 10,
      old: false,
      base: false,
      grace: 60,
      active: 0,
      staleMinutes: 0,
    },
    {
      name: "a configured longer grace period",
      mirror: baseSha,
      recentMinutes: 10,
      old: true,
      base: true,
      grace: 180,
      active: 0,
      staleMinutes: 0,
    },
    {
      name: "a change just inside the grace boundary",
      mirror: oldSha,
      recentMinutes: 59.75,
      old: true,
      base: true,
      grace: 60,
      active: 0,
      staleMinutes: 0,
    },
  ])("handles $name without live network access", (scenario) => {
    const root = createTempDir("openclaw-docs-mirror-");
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".github/workflows/docs-sync-publish.yml"),
      "on:\n  push:\n    paths:\n      - watched-docs/**\n      - scripts/publish-support.mjs\n",
    );
    const requestsPath = path.join(root, "requests.jsonl");
    writeFileSync(requestsPath, "");
    const preload = path.join(root, "github-fixture.mjs");
    writeFileSync(
      preload,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const rejectNetwork = () => { throw new Error("Unexpected network connection"); };
net.connect = net.createConnection = net.Socket.prototype.connect = rejectNetwork;
syncBuiltinESMExports();
const scenario = ${JSON.stringify(scenario)};
const now = Date.parse("2026-09-09T12:00:00Z");
Date.now = () => now;
const commit = (sha, minutes) => ({ sha, commit: { committer: { date: new Date(now - minutes * 60000).toISOString() } } });
const base = scenario.base ? [commit(${JSON.stringify(baseSha)}, 360)] : [];
const history = {
  "watched-docs": [commit(${JSON.stringify(newestSha)}, scenario.recentMinutes), ...base],
  "scripts/publish-support.mjs": [...(scenario.old ? [commit(${JSON.stringify(oldSha)}, 120)] : []), ...base],
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const method = init.method ?? "GET";
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(new Headers(init.headers).has("authorization"), false);
  fs.appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({ method, pathname: url.pathname, search: url.search }) + "\\n");
  let body;
  if (method === "GET" && url.pathname === "/repos/openclaw/openclaw/commits") {
    assert.equal(url.searchParams.get("sha"), "main");
    assert.equal(url.searchParams.get("per_page"), "1");
    const entries = history[url.searchParams.get("path")];
    assert.ok(entries, "watched paths must come from the workflow");
    const until = url.searchParams.get("until");
    if (until) assert.equal(Date.parse(until), now - scenario.grace * 60000);
    body = entries.filter(entry => !until || Date.parse(entry.commit.committer.date) <= Date.parse(until)).slice(0, 1);
  } else if (method === "GET" && url.pathname === "/repos/openclaw/docs/contents/.openclaw-sync/source.json") {
    assert.equal(url.searchParams.get("ref"), "main");
    body = { content: Buffer.from(JSON.stringify({ sha: scenario.mirror })).toString("base64") };
  } else if (method === "GET" && url.pathname.startsWith("/repos/openclaw/openclaw/compare/")) {
    const [from, to] = url.pathname.split("/").at(-1).split("...");
    const order = ${JSON.stringify([baseSha, oldSha, newestSha])};
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
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(scenario.staleMinutes ? 1 : 0);
    const requests = readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(
      scenario.staleMinutes && !scenario.active ? 1 : 0,
    );
    if (scenario.staleMinutes) {
      expect(result.stderr).toContain(`docs mirror stale for ${scenario.staleMinutes}m`);
      expect(result.stderr).toContain(
        scenario.recentMinutes === scenario.staleMinutes ? newestSha : oldSha,
      );
    } else {
      expect(result.stdout).toContain(
        scenario.mirror === newestSha ? "docs mirror fresh:" : `within ${scenario.grace}m grace`,
      );
    }
  });
});
