import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  acquireDistArtifactOwnership,
  resolveDistArtifactLockPath,
} from "../../../scripts/lib/dist-artifact-ownership.mts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  continuePostCoreUpdateInFreshProcess,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["joined", "uncertain", "legacy"] as const)(
  "carries Doctor restoration facts and artifact cleanup through the post-core child (%s)",
  async (cleanup) => {
    const root = await fs.realpath(tempDirs.make("post-core-doctor-failure-"));
    const recordedPath = path.join(root, "failure.json");
    const observedPath = path.join(root, "child-owner.json");
    const directory = resolveDistArtifactLockPath(root);
    const ownerPath = path.join(directory, "owner.json");
    const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
    for (const relative of [
      "scripts/lib/dist-artifact-ownership.mts",
      "scripts/lib/dist-artifact-lock.mts",
      "scripts/lib/direct-run.mjs",
      "scripts/lib/managed-child-process.mts",
      "scripts/lib/repo-root.mjs",
      "scripts/lib/vitest-resource-ownership.mts",
      "scripts/lib/windows-taskkill.mjs",
      "scripts/windows-cmd-helpers.mjs",
      "src/infra/windows-process-start.ts",
      "src/infra/process-env.ts",
    ]) {
      const destination = path.join(root, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(sourceRoot, relative), destination);
    }
    await fs.mkdir(path.join(root, "node_modules", "@openclaw"), { recursive: true });
    await fs.symlink(
      path.join(sourceRoot, "node_modules", "@openclaw", "fs-safe"),
      path.join(root, "node_modules", "@openclaw", "fs-safe"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.writeFile(
      path.join(root, "scripts", "stage-bundled-plugin-runtime.mts"),
      "export {};\n",
    );
    if (cleanup === "legacy") {
      await fs.copyFile(
        path.join(sourceRoot, "test/scripts/fixtures/dist-artifact-ownership-2026.9.5.mts.txt"),
        path.join(root, "scripts/lib/dist-artifact-ownership.mts"),
      );
      await fs.writeFile(path.join(root, "scripts", "tsx.mjs"), "export {};\n");
    }
    const facts = [
      {
        check: "gateway-restoration",
        code: "doctor-gateway-rpc-verification-failed",
        message: "rpc-verification: installed candidate did not answer",
      },
      {
        check: "gateway-restoration",
        code: "stale-gateway-recovery-command",
        message: "openclaw gateway status --deep",
      },
    ];
    const error = new UpdateDoctorError("Doctor Gateway restoration failed", facts);
    await writePostCoreUpdateFailureFile(
      recordedPath,
      new AggregateError(
        [
          new Error("finalization failed"),
          error,
          ...(cleanup === "uncertain" ? [new CommandProcessCleanupError()] : []),
        ],
        "Finalization and restoration failed",
      ),
    );
    if (cleanup === "legacy") {
      const receipt = JSON.parse(await fs.readFile(recordedPath, "utf8"));
      delete receipt.cleanup;
      await fs.writeFile(recordedPath, JSON.stringify(receipt));
    }
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "9999.1.1" }),
    );
    await fs.writeFile(
      path.join(root, "dist", "entry.mjs"),
      `import fs from "node:fs/promises";
import path from "node:path";
await fs.writeFile(${JSON.stringify(observedPath)}, JSON.stringify({
  pid: process.pid,
  owner: await fs.readFile(${JSON.stringify(ownerPath)}, "utf8"),
  claim: (await fs.stat(path.join(${JSON.stringify(directory)}, "child-" + process.pid))).isFile(),
}));
await fs.copyFile(${JSON.stringify(recordedPath)}, process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH);
process.exitCode = 1;`,
    );

    const artifactOwnership = await acquireDistArtifactOwnership(root, { runtimeChildren: true });
    const owner = await fs.readFile(ownerPath, "utf8");
    try {
      const continuation = continuePostCoreUpdateInFreshProcess({
        root,
        channel: "stable",
        requestedChannel: null,
        opts: {
          json: true,
          yes: true,
          run: {
            runId: "post-core-failure-fixture",
            env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
            artifactOwnership,
          },
        },
        pluginInstallRecords: {},
        updateStartedAtMs: Date.now(),
        timeoutMs: 5000,
        nodeRunner: process.execPath,
      });

      if (cleanup === "uncertain") {
        const failure = await continuation.catch((cause: unknown) => cause);
        expect(hasCommandProcessCleanupError(failure)).toBe(true);
        expect(failure).toMatchObject({
          cause: { message: expect.stringContaining("Doctor Gateway restoration failed") },
        });
      } else {
        expect(await continuation).toMatchObject({
          resumed: false,
          exitCode: 1,
          error: expect.stringContaining("Doctor Gateway restoration failed"),
          failureFacts: facts,
        });
      }
      expect(JSON.parse(await fs.readFile(observedPath, "utf8"))).toMatchObject({
        owner,
        claim: true,
      });
      expect((await fs.readdir(directory)).some((entry) => entry.startsWith("child-"))).toBe(
        cleanup === "uncertain",
      );
    } finally {
      await artifactOwnership.release();
    }
    if (cleanup === "joined") {
      await expect(fs.stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await fs.readFile(ownerPath, "utf8")).toBe(owner);
    }
  },
);
