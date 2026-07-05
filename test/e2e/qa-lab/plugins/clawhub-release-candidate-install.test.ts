// ClawHub release candidate producer tests cover blocked script evidence output.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "../../../../extensions/qa-lab/api.js";

const SOURCE_PATH = "test/e2e/qa-lab/plugins/clawhub-release-candidate-install.ts";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ClawHub release candidate install producer", () => {
  it("writes blocked evidence when no candidate tarball is available", async () => {
    const artifactBase = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-clawhub-release-evidence-"),
    );
    tempRoots.push(artifactBase);
    const missingTarballEnv = "OPENCLAW_TEST_MISSING_RELEASE_CANDIDATE_TARBALL";
    const env = { ...process.env };
    delete env[missingTarballEnv];

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        SOURCE_PATH,
        "--artifact-base",
        artifactBase,
        "--tarball-env",
        missingTarballEnv,
      ],
      { cwd: process.cwd(), encoding: "utf8", env },
    );

    expect(result.status).toBe(0);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(artifactBase, "qa-evidence.json"), "utf8")),
    );
    expect(evidence.entries[0]).toMatchObject({
      execution: {
        artifacts: [{ kind: "log", path: "parallels-npm-update.log", source: "script" }],
      },
      result: {
        status: "blocked",
        failure: {
          reason: expect.stringContaining(`${missingTarballEnv} is not set`),
        },
      },
    });
    expect(result.stdout).toContain("ClawHub release-candidate install status: blocked");
  });
});
