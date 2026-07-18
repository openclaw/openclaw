// POSIX wrapper simulation never installs or starts the real Gateway service.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  readUpdateRollbackTransaction,
  writeUpdateRollbackTransaction,
} from "../infra/update-rollback.js";
import { buildUpdateRollbackSupervisorScript } from "./update-rollback-wrapper.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function waitForPath(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await fs.access(targetPath).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${targetPath}`);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("update rollback service wrapper", () => {
  it.runIf(process.platform !== "win32")(
    "restores and launches the retained package after first-start failure",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-rollback-"));
      temporaryRoots.push(root);
      const stateDir = path.join(root, "state");
      const currentRoot = path.join(root, "current");
      const retainedRoot = path.join(root, "retained");
      const outputPath = path.join(root, "started.txt");
      const gatewayRelativePath = "gateway.sh";
      await fs.mkdir(currentRoot, { recursive: true });
      await fs.mkdir(retainedRoot, { recursive: true });
      await fs.writeFile(path.join(currentRoot, gatewayRelativePath), "#!/bin/sh\nexit 23\n", {
        mode: 0o700,
      });
      await fs.writeFile(
        path.join(retainedRoot, gatewayRelativePath),
        `#!/bin/sh\nprintf '%s\\n' old-started > '${outputPath}'\n`,
        { mode: 0o700 },
      );
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeUpdateRollbackTransaction({
        env,
        transaction: {
          state: "pending",
          newVersion: "2.0.0",
          previousVersion: "1.9.0",
          currentRoot,
          retainedRoot,
          gatewayPort: 19999,
        },
      });
      const wrapperPath = path.join(root, "wrapper.sh");
      await fs.writeFile(
        wrapperPath,
        buildUpdateRollbackSupervisorScript({
          markerPath: path.join(stateDir, "update-rollback"),
          healthTimeoutSeconds: 2,
        }),
        { mode: 0o700 },
      );

      await execFileAsync("/bin/sh", [wrapperPath, path.join(currentRoot, gatewayRelativePath)]);

      expect(await fs.readFile(outputPath, "utf8")).toBe("old-started\n");
      expect(await fs.readFile(path.join(currentRoot, gatewayRelativePath), "utf8")).toContain(
        "old-started",
      );
      const transaction = await readUpdateRollbackTransaction(env);
      expect(transaction).toMatchObject({
        state: "rolled_back",
        newVersion: "2.0.0",
        previousVersion: "1.9.0",
        error: "gateway exited with status 23 before readiness",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "honors the environment escape without restoring the retained package",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-no-rollback-"));
      temporaryRoots.push(root);
      const stateDir = path.join(root, "state");
      const currentRoot = path.join(root, "current");
      const retainedRoot = path.join(root, "retained");
      await fs.mkdir(currentRoot, { recursive: true });
      await fs.mkdir(retainedRoot, { recursive: true });
      const gatewayPath = path.join(currentRoot, "gateway.sh");
      await fs.writeFile(gatewayPath, "#!/bin/sh\nexit 23\n", { mode: 0o700 });
      await fs.writeFile(path.join(retainedRoot, "gateway.sh"), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeUpdateRollbackTransaction({
        env,
        transaction: {
          state: "pending",
          newVersion: "2.0.0",
          previousVersion: "1.9.0",
          currentRoot,
          retainedRoot,
          gatewayPort: 19999,
        },
      });
      const wrapperPath = path.join(root, "wrapper.sh");
      await fs.writeFile(
        wrapperPath,
        buildUpdateRollbackSupervisorScript({
          markerPath: path.join(stateDir, "update-rollback"),
          healthTimeoutSeconds: 1,
        }),
        { mode: 0o700 },
      );

      await expect(
        execFileAsync("/bin/sh", [wrapperPath, gatewayPath], {
          env: { ...process.env, OPENCLAW_UPDATE_NO_ROLLBACK: "1" },
        }),
      ).rejects.toMatchObject({ code: 23 });

      expect(await fs.readFile(gatewayPath, "utf8")).toContain("exit 23");
      await expect(fs.access(path.join(stateDir, "update-rollback"))).rejects.toThrow();
    },
  );

  it.runIf(process.platform !== "win32")(
    "forwards service shutdown without treating it as a failed update",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-shutdown-"));
      temporaryRoots.push(root);
      const stateDir = path.join(root, "state");
      const currentRoot = path.join(root, "current");
      const retainedRoot = path.join(root, "retained");
      const startedPath = path.join(root, "started.txt");
      const stoppedPath = path.join(root, "stopped.txt");
      await fs.mkdir(currentRoot, { recursive: true });
      await fs.mkdir(retainedRoot, { recursive: true });
      const gatewayPath = path.join(currentRoot, "gateway.sh");
      await fs.writeFile(
        gatewayPath,
        `#!/bin/sh\ntrap "printf stopped > '${stoppedPath}'; exit 0" TERM\nprintf started > '${startedPath}'\nwhile :; do sleep 1; done\n`,
        { mode: 0o700 },
      );
      await fs.writeFile(path.join(retainedRoot, "gateway.sh"), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeUpdateRollbackTransaction({
        env,
        transaction: {
          state: "pending",
          newVersion: "2.0.0",
          previousVersion: "1.9.0",
          currentRoot,
          retainedRoot,
          gatewayPort: 19999,
        },
      });
      const wrapperPath = path.join(root, "wrapper.sh");
      await fs.writeFile(
        wrapperPath,
        buildUpdateRollbackSupervisorScript({
          markerPath: path.join(stateDir, "update-rollback"),
          healthTimeoutSeconds: 5,
        }),
        { mode: 0o700 },
      );

      const wrapper = spawn("/bin/sh", [wrapperPath, gatewayPath], { stdio: "ignore" });
      await waitForPath(startedPath);
      wrapper.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => {
        wrapper.once("error", reject);
        wrapper.once("exit", () => resolve());
      });

      expect(await fs.readFile(stoppedPath, "utf8")).toBe("stopped");
      expect(await readUpdateRollbackTransaction(env)).toMatchObject({ state: "pending" });
      expect(await fs.readFile(gatewayPath, "utf8")).toContain("while :");
    },
  );
});
