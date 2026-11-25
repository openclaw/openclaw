import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { npmRegistryPackument } from "./plugin-npm-publication-readback.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readback(fault: string, deferVisibility = true, route = "npm-oidc") {
  const root = tempDirs.make("plugin-npm-readback-");
  const bytes = Buffer.from("qualified plugin bytes");
  const tarball = join(root, "plugin.tgz");
  const summary = join(root, "summary.md");
  const name = "@openclaw/demo";
  const version = "2026.9.2-beta.1";
  const packument = npmRegistryPackument(name, version, bytes);
  writeFileSync(tarball, bytes);
  writeFileSync(summary, "");
  const preload = `// Only explicit retry waits advance the mocked registry's clock.
let now = Date.now();
Date.now = () => now;
const delay = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  now += ms;
  return delay(fn, 0, ...args);
};
const packument = ${JSON.stringify(packument)};
const fault = ${JSON.stringify(fault)};
const bytes = Buffer.from(${JSON.stringify(bytes.toString())});
if (fault === "missing-version") packument.versions = {};
if (fault === "integrity") packument.versions[${JSON.stringify(version)}].dist.shasum = "0".repeat(40);
if (fault === "selector") packument["dist-tags"].beta = "2026.9.1-beta.1";
if (fault === "ahead-selector") packument["dist-tags"].beta = "2026.9.3-beta.1";
if (fault === "malformed-selector") packument["dist-tags"].beta = {};
if (fault === "package-name") packument.versions[${JSON.stringify(version)}].name = "@openclaw/other";
if (fault === "package-version") packument.versions[${JSON.stringify(version)}].version = "2026.9.2-beta.2";
globalThis.fetch = async (url, init) => {
  if (!url.startsWith("https://registry.npmjs.org/") || (init?.method ?? "GET") !== "GET") {
    throw new Error("Unexpected registry mutation or destination");
  }
  const status = {unavailable: 503, forbidden: 403}[fault];
  if (status) return new Response(null, {status});
  if (url.endsWith(".tgz")) {
    if (fault === "missing-tarball") return new Response(null, {status: 404});
    if (fault === "oversized") return new Response(Buffer.concat([bytes, bytes]));
    return new Response(fault === "bytes" ? Buffer.alloc(bytes.length) : bytes);
  }
  return Response.json(fault === "malformed" ? {} : packument);
};
`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      "scripts/plugin-npm-prepared-release.mjs",
      "registry",
      ...Object.entries({
        "package-name": name,
        version,
        "publish-tag": "beta",
        route,
        tarball,
        "allow-missing": "false",
        "defer-visibility": String(deferVisibility),
      }).flatMap(([key, value]) => [`--${key}`, value]),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summary,
        OPENCLAW_NPM_READBACK_TIMEOUT_MS: "100",
      },
    },
  );
  return { ...result, summary: readFileSync(summary, "utf8") };
}

it.each([
  ...["missing-version", "missing-tarball", "unavailable", "selector"].map(
    (fault) => [fault, true, "npm-oidc", "pending"] as const,
  ),
  ["missing-tarball", false, "npm-token-bootstrap", "rejected"],
  ["missing-version", true, "npm-readback", "rejected"],
  ["selector", false, "npm-oidc", "rejected"],
  ...[
    "integrity",
    "bytes",
    "ahead-selector",
    "malformed-selector",
    "package-name",
    "package-version",
    "oversized",
    "malformed",
    "forbidden",
  ].map((fault) => [fault, true, "npm-oidc", "rejected"] as const),
  ["none", true, "npm-oidc", "verified"],
] as const)("reports %s with defer=%s, route=%s as %s", (fault, defer, route, outcome) => {
  const result = readback(fault, defer, route);
  expect(result.status, result.stderr).toBe(outcome === "rejected" ? 1 : 0);
  if (outcome === "pending") {
    expect(result.stderr).toContain("published, visibility pending");
    expect(result.summary).toContain("published, visibility pending");
    expect(result.summary).toContain("parent's final registry verification");
  } else {
    expect(result.summary).toBe("");
    expect(result.stderr).not.toContain("published, visibility pending");
    if (outcome === "verified") {
      expect(result.stdout).toContain("verified exact published bytes and selector");
    }
  }
});
