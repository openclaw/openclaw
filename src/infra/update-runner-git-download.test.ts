import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createGitUpdateFixture,
  expectRuntime,
  runFixtureGit as git,
  writeGitFixtureManifest,
} from "./update-runner-git-candidate.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("retains downloaded objects after candidate rejection, then validates and activates the same release before clearing its cache", async () => {
  const directory = temporary.make("openclaw-git-download-update-");
  const fixture = await createGitUpdateFixture(directory, { version: "2026.7.1" });
  await git(fixture.remote, "config", "uploadpack.allowFilter", "true");
  await git(
    fixture.root,
    "remote",
    "set-url",
    "origin",
    "https://github.com/openclaw/openclaw.git",
  );
  const savedConfig = await fs.readFile(path.join(fixture.root, ".git/config"));
  const payload = Buffer.from("large update asset\n".repeat(65_536));
  await fs.writeFile(path.join(fixture.remote, "large asset.bin"), payload);
  await writeGitFixtureManifest(fixture.remote, { version: "2026.7.2" });
  const target = await fixture.advanceRemote();
  await git(fixture.remote, "tag", "v2026.7.2", target);
  const http = vi.fn(() => {
    throw new Error("Source updates must keep Git compression without raw downloads");
  });
  vi.stubGlobal("fetch", http);
  const execute = fixture.runCommand;
  fixture.runCommand = (argv, options) => {
    const fetch = argv.indexOf("fetch");
    const origin = fetch === -1 ? -1 : argv.indexOf("origin", fetch + 1);
    const actual = [...argv];
    if (origin !== -1) {
      // Keep the named promisor remote; scope the peer rewrite to this fetch only.
      actual.splice(
        1,
        0,
        "-c",
        `url.${pathToFileURL(fixture.remote).href}.insteadOf=https://github.com/openclaw/openclaw.git`,
      );
    }
    return execute(actual, options);
  };
  let rejectCandidate = true;
  const update = () =>
    fixture.update({
      channel: "stable",
      inspectGitTarget: async () => {
        fixture.events.push("inspect");
      },
      validateCandidate: async (candidateRoot) => {
        await fixture.validateCandidate(candidateRoot);
        if (rejectCandidate) {
          throw new Error("candidate validation rejected");
        }
      },
      runGitDoctor: async (root) => {
        expect(fixture.stopped).toBe(true);
        fixture.events.push("doctor");
        return {
          name: "openclaw doctor",
          command: "activation Doctor fixture",
          cwd: root,
          durationMs: 0,
          exitCode: 0,
        };
      },
    });
  await expect(update()).rejects.toThrow("candidate validation rejected");
  expect(fixture.stopped).toBe(false);
  expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.beforeSha);
  await expectRuntime(fixture.root, fixture.beforeSha);
  expect(await fs.readFile(path.join(fixture.root, ".git/config"))).toEqual(savedConfig);
  expect(http).not.toHaveBeenCalled();
  const cache = path.join(fixture.root, ".artifacts/git-downloads/official");
  expect((await fs.stat(path.join(cache, "repository.git/objects"))).isDirectory()).toBe(true);
  expect(fixture.events).not.toContain("stop");

  rejectCandidate = false;
  fixture.events.length = 0;
  const result = await update();
  expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", after: { sha: target } });
  expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(target);
  expect(await git(fixture.root, "rev-parse", "HEAD^{tree}")).toBe(
    await git(fixture.remote, "rev-parse", `${target}^{tree}`),
  );
  expect(await fs.readFile(path.join(fixture.root, "large asset.bin"))).toEqual(payload);
  await expectRuntime(fixture.root, target);
  expect(http).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(fixture.root, ".git/config"))).toEqual(savedConfig);
  for (const [earlier, later] of [
    ["inspect", "build"],
    ["build", "validate"],
    ["validate", "stop"],
    ["stop", "doctor"],
  ] as const) {
    expect(fixture.events.indexOf(earlier)).toBeLessThan(fixture.events.indexOf(later));
  }
  await expect(fs.stat(path.join(cache, "repository.git"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
