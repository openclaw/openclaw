import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveVitestWorkerBuildInfo } from "../../scripts/lib/vitest-worker-build-info.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

const host = {
  version: "2026.11.1",
  commit: "a".repeat(40),
  builtAt: "2026-11-01T00:00:00.000Z",
  buildId: "host-build",
};
const overrides = {
  GIT_COMMIT: "b".repeat(40),
  OPENCLAW_BUILD_TIMESTAMP: "2026-11-02T00:00:00.000Z",
  OPENCLAW_CONTROL_UI_BUILD_ID: "worker-build",
};

it("inherits complete host identity ahead of checkout and environment hints", async ({
  onTestFinished,
}) => {
  const lifetime = createFixtureLifetime();
  onTestFinished(() => lifetime.cleanup());
  await lifetime.run(async () => {
    const root = lifetime.createTempDir("worker-build-info-", os.tmpdir());
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "package.json"), '{"version":"2026.11.20"}');
    fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify(host));
    expect(resolveVitestWorkerBuildInfo(root, overrides)).toEqual(host);
  });
});

it("keeps source-only build synthesis when host metadata is absent", async ({ onTestFinished }) => {
  const lifetime = createFixtureLifetime();
  onTestFinished(() => lifetime.cleanup());
  await lifetime.run(async () => {
    const root = lifetime.createTempDir("worker-build-info-", os.tmpdir());
    fs.writeFileSync(path.join(root, "package.json"), '{"version":"2026.11.20"}');
    expect(resolveVitestWorkerBuildInfo(root, overrides)).toEqual({
      version: "2026.11.20",
      commit: overrides.GIT_COMMIT,
      builtAt: overrides.OPENCLAW_BUILD_TIMESTAMP,
      buildId: overrides.OPENCLAW_CONTROL_UI_BUILD_ID,
    });
  });
});

it.for([
  "{",
  "null",
  "[]",
  JSON.stringify({ ...host, commit: "short" }),
  JSON.stringify({ ...host, builtAt: "2026-02-30T00:00:00Z" }),
  JSON.stringify({ ...host, buildId: "" }),
  JSON.stringify({ ...host, buildId: "invalid id" }),
  JSON.stringify({ ...host, version: undefined }),
  JSON.stringify({ ...host, commit: undefined }),
])(
  "rejects malformed host metadata instead of minting another identity: %s",
  async (contents, { onTestFinished }) => {
    const lifetime = createFixtureLifetime();
    onTestFinished(() => lifetime.cleanup());
    await lifetime.run(async () => {
      const root = lifetime.createTempDir("worker-build-info-", os.tmpdir());
      fs.mkdirSync(path.join(root, "dist"));
      fs.writeFileSync(path.join(root, "dist/build-info.json"), contents);
      expect(() => resolveVitestWorkerBuildInfo(root, overrides)).toThrow(
        "Invalid host dist/build-info.json for compiled test workers",
      );
    });
  },
);
