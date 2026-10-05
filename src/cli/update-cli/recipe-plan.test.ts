import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareExecutableRecipePlan } from "./recipe-plan.js";

it("refuses actual uninitialized shared state before private staging and preserves authored config", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "recipe-plan-admission-")),
  );
  try {
    const installationRoot = path.join(root, "installation");
    const stateRoot = path.join(root, "selected-state");
    const runnerRoot = path.join(root, "runner");
    const artifactsDirectory = path.join(root, "artifacts");
    await Promise.all(
      [installationRoot, stateRoot, runnerRoot, artifactsDirectory].map((directory) =>
        fs.mkdir(directory, { mode: 0o700 }),
      ),
    );
    const configPath = path.join(stateRoot, "openclaw.json");
    const configBytes = '{"gateway":{"port":18789}}\n';
    await fs.writeFile(configPath, configBytes, { mode: 0o600 });
    const localArchivePath = path.join(artifactsDirectory, "target.tgz");
    await fs.writeFile(localArchivePath, "not admitted", { mode: 0o600 });
    // No fixture catalog or startup is fabricated: this actual producer must
    // stop before authentication/staging because the selected shared DB is absent.
    await expect(
      prepareExecutableRecipePlan({
        installationRoot,
        stateRoot,
        configPath,
        runnerRoot,
        artifactsDirectory,
        localArchivePath,
        profile: "default",
        port: 18789,
        timeoutMs: 1000,
        runnerEntryUrl: import.meta.url,
        runnerManifestArtifactId: "runner",
        sourceReleaseId: "source",
        targetReleaseId: "target",
        qualificationId: "qualification",
        catalog: {
          controlRoot: path.join(root, "absent-control"),
          metadataDir: path.join(root, "absent-control", "metadata"),
          metadataBaseUrl: "https://metadata.invalid/",
          targetBaseUrl: "https://targets.invalid/",
          targetPath: "catalog",
          forbiddenRoots: [installationRoot, stateRoot],
        },
      }),
    ).rejects.toThrow("existing initialized shared state");
    expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
    expect(await fs.readdir(stateRoot)).toEqual(["openclaw.json"]);
    expect(await fs.readdir(installationRoot)).toEqual([]);
    expect(await fs.readdir(artifactsDirectory)).toEqual(["target.tgz"]);
    expect(await fs.readdir(root)).toEqual([
      "artifacts",
      "installation",
      "runner",
      "selected-state",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
