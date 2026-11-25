import { readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  publishedDriverFixtureVersion,
  withPublishedDriverUpdate,
} from "../../scripts/e2e/lib/upgrade-survivor/published-driver-update.mjs";
import { resolveExtendedStablePackage } from "../../src/infra/update-check.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeTarball } from "./prepublish-plugin-registry.fixture.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  ["2026.10.33", "2026.9.37", "2026.10.33"],
  ["2026.9.37", "2026.9.37", "2026.9.38"],
  ["2026.9.33", "2026.9.37", "2026.9.38"],
  ["2026.10.1", "2026.10.33", "2026.10.34"],
  ["2026.10.1", "2026.10.2", "2026.10.2"],
])("selects fixture %s from driver %s as %s", (candidate, driver, expected) => {
  expect(publishedDriverFixtureVersion(candidate, driver)).toBe(expected);
});

it("resolves the exact candidate through the extended-stable selector without a tag or channel override", async () => {
  const runtime = dirs.make("published-driver-selector-");
  const version = "2026.10.33";
  const tarball = writeTarball(runtime, path.join(runtime, "candidate.tgz"), "openclaw", version);
  const env = { PATH: process.env.PATH };
  let registryUrl = "";
  await withPublishedDriverUpdate({
    fromVersion: "2026.9.37",
    toVersion: version,
    tarball,
    runtime,
    env,
    timeoutMs: 10_000,
    run: async (args: string[], updateEnv: NodeJS.ProcessEnv) => {
      expect(args).toEqual(["update", "--yes", "--json"]);
      expect(updateEnv.OPENCLAW_UPDATE_PACKAGE_SPEC).toBe("openclaw");
      registryUrl = updateEnv.NPM_CONFIG_REGISTRY!;
      expect(
        await resolveExtendedStablePackage({ installKind: "package", env: updateEnv }),
      ).toEqual({
        status: "resolved",
        selector: "extended-stable",
        version,
        packageSpec: "openclaw@2026.10.33",
      });
      const manifest = await (await fetch(registryUrl + "/openclaw/2026.10.33")).json();
      const archive = await fetch(manifest.dist.tarball);
      expect(Buffer.from(await archive.arrayBuffer())).toEqual(readFileSync(tarball));
    },
  });
  expect(env).toEqual({ PATH: process.env.PATH });
  // Check the listener directly: an injected HTTP proxy may answer 502 after shutdown.
  const listening = await new Promise<boolean>((resolve) => {
    const socket = connect(Number(new URL(registryUrl).port), "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  expect(listening).toBe(false);
});

it.each([
  ["2026.9.7", "2026.10.1", []],
  ["2026.9.37", "2026.10.1", ["--channel", "stable"]],
  ["2026.10.33", "2026.10.34-first-hop.1", ["--channel", "stable"]],
  ["2026.10.34-first-hop.1", "2026.10.34-first-hop.2", []],
])(
  "retains explicit artifact updates from %s to %s",
  async (fromVersion, toVersion, channelArgs) => {
    const env = { PATH: process.env.PATH };
    const result = await withPublishedDriverUpdate({
      fromVersion,
      toVersion,
      tarball: "/candidate.tgz",
      runtime: dirs.make("published-driver-artifact-"),
      timeoutMs: 10_000,
      env,
      extra: ["--no-restart"],
      run: (args: string[], updateEnv: NodeJS.ProcessEnv) => {
        expect(args).toEqual([
          "update",
          "--yes",
          "--json",
          "--no-restart",
          "--tag",
          "/candidate.tgz",
          ...channelArgs,
        ]);
        expect(updateEnv).toBe(env);
        return 17;
      },
    });
    expect(result).toBe(17);
  },
);
