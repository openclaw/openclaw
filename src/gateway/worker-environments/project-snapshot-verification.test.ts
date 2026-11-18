import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createWorkerProjectPreparation } from "./project-preparation.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("prepared snapshot inspection", () => {
  it("captures eligible setup output from its prepared HOME manifest", async () => {
    const f = await createProjectPreparationFixture(
      tempDirs.make("snapshot-generated-project-"),
      "#!/bin/sh\nprintf generated > generated.txt\n",
    );
    const owner = await f.preparedOperation();
    try {
      const prepared = (await owner.project.prepare(f)).preparedWorkspace!;
      expect(prepared.preparedManifestRef).not.toBe(prepared.sourceManifestRef);
      await expect(
        fs.access(
          path.join(
            f.home,
            ".openclaw-worker",
            "manifests",
            prepared.preparedManifestRef.slice(7) + ".json",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        owner.project.inspectPreparedWorkspace!({ snapshot: true, runScript: f.runScript }),
      ).resolves.toMatchObject(prepared);
      expect(await fs.readFile(path.join(prepared.workspaceDir, "generated.txt"), "utf8")).toBe(
        "generated",
      );
    } finally {
      owner.close();
    }
  });
  it.each([
    "unchanged",
    "completion",
    "manifest",
    "workspace",
    "seed",
    "symlink",
    "closed-owner",
  ] as const)("admits only the current completed root set: %s", async (change) => {
    const f = await createProjectPreparationFixture(tempDirs.make("snapshot-project-"));
    let current = true;
    const owner = await f.preparedOperation(() => {
      if (!current) {
        throw new Error("project owner closed");
      }
    });
    try {
      const prepared = (await owner.project.prepare(f)).preparedWorkspace!;
      const workerRoot = path.join(f.home, ".openclaw-worker");
      if (change === "completion") {
        await fs.rm(path.join(prepared.homeDir, ".openclaw-worker", "manifests", "prepared"), {
          recursive: true,
        });
      } else if (change === "manifest") {
        await fs.writeFile(
          path.join(workerRoot, "manifests", prepared.sourceManifestRef.slice(7) + ".json"),
          "{}",
        );
      } else if (change === "workspace") {
        await fs.writeFile(path.join(prepared.workspaceDir, "input.txt"), "changed content");
      } else if (change === "seed") {
        await fs.writeFile(path.join(f.seed, "input.txt"), "changed seed");
      } else if (change === "symlink") {
        await fs.rename(f.seed, f.seed + "-moved");
        await fs.symlink(f.seed + "-moved", f.seed);
      }
      const inspected = owner.project.inspectPreparedWorkspace!({
        snapshot: true,
        runScript: async (script) => {
          const result = await f.runScript(script);
          if (change === "closed-owner") {
            current = false;
          }
          return result;
        },
      });
      if (change === "unchanged") {
        await expect(inspected).resolves.toMatchObject({
          namespace: "gateway",
          cacheKey: "c".repeat(64),
          baseCommit: f.project.baseCommit,
          workspaceDir: prepared.workspaceDir,
          homeDir: prepared.homeDir,
          sourceManifestRef: prepared.sourceManifestRef,
          preparedManifestRef: prepared.preparedManifestRef,
        });
      } else {
        await expect(inspected).rejects.toThrow(
          change === "closed-owner" ? "project owner closed" : undefined,
        );
      }
    } finally {
      owner.close();
    }
  });

  it.each(["fresh", "ordinary", "other base"] as const)(
    "carries completed workspace provenance only for a matching fresh fork: %s",
    async (mode) => {
      const f = await createProjectPreparationFixture(tempDirs.make("snapshot-fork-"));
      const initial = await f.preparedOperation();
      await initial.project.prepare(f);
      initial.close();
      const restored = await f.preparedOperation();
      try {
        const result = await restored.project.prepare({
          ...f,
          ...(mode !== "ordinary"
            ? {
                snapshotBaseCommit: mode === "other base" ? "f".repeat(40) : f.project.baseCommit,
                initialSnapshotCheckpointId: "checkpoint-fresh",
              }
            : {}),
        });
        expect(restored.getInitialSnapshot()).toEqual(
          mode === "fresh"
            ? {
                checkpointId: "checkpoint-fresh",
                baseCommit: f.project.baseCommit,
                sourceManifestRef: result.preparedWorkspace!.sourceManifestRef,
                preparedManifestRef: result.preparedWorkspace!.preparedManifestRef,
              }
            : undefined,
        );
      } finally {
        restored.close();
      }
    },
  );

  it("rechecks repository source authority before invoking the inspection transport", async () => {
    const owner = createWorkerProjectPreparation({
      project: {
        key: "a".repeat(64),
        baseCommit: "b".repeat(40),
        source: {
          kind: "repository",
          url: "https://github.com/openclaw/synthetic.git",
          repositoryId: "R_synthetic",
          owner: {
            agent: { agentId: "main", provenance: null },
            identity: { source: "anonymous" },
          },
        },
      },
      namespace: "gateway",
      preparation: {
        key: "c".repeat(64),
        cacheKey: "d".repeat(64),
        purpose: "reserve",
        demandAtMs: 1,
      },
      revalidateRepositorySource: async () => {
        throw new Error("source revoked");
      },
      requireCurrent: () => {},
    });
    try {
      await expect(
        owner.project.inspectPreparedWorkspace!({
          snapshot: true,
          runScript: async () => {
            throw new Error("unexpected transport effect");
          },
        }),
      ).rejects.toThrow("source revoked");
    } finally {
      owner.close();
    }
  });
});
