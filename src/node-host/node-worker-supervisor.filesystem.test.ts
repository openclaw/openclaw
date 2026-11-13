import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import {
  createObservedNodeWorkerSupervisorFixture,
  observeNodeWorkerAdapters,
} from "./node-worker-supervisor.fixture.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import { ensureNodeWorkerWorkspaceSessionRoot } from "./node-worker-workspace-identity.js";

const tempDirs = useStateDatabaseTempDirs();

describe.runIf(process.platform === "linux")("filesystem-isolated worker owner", () => {
  it.each([false, true])(
    "preserves worker IPC and extinction when scratch cleanup is denied: %s",
    async (denyCleanup) => {
      const root = tempDirs.make("worker-filesystem-");
      const home = path.join(root, "home");
      const privateDir = path.join(root, "private");
      fs.mkdirSync(home);
      fs.mkdirSync(privateDir);
      const canary = path.join(privateDir, "canary");
      fs.writeFileSync(canary, "original");
      await using f = createObservedNodeWorkerSupervisorFixture(root, {
        filesystemIsolation: true,
        env: {
          OPENCLAW_STATE_DIR: path.join(root, "state-root"),
          HOME: home,
          PATH: process.env.PATH,
        },
      });
      const input = testWorkerLaunchInput(f.workspaceDir, "filesystem-launch");
      const { environmentId, sessionId, ownerEpoch } = input.descriptor.admission;
      const session = ensureNodeWorkerWorkspaceSessionRoot(
        f.bundleRoot,
        input.gatewayNamespace,
        environmentId,
        sessionId,
      );
      const workspace = path.join(session, String(ownerEpoch));
      fs.mkdirSync(workspace);
      input.descriptor.assignment.workspaceDir = workspace;
      const source = TEST_WORKER_SOURCE.replace(
        "const mode = descriptor.assignment.prompt;",
        `const mode = descriptor.assignment.prompt;
       const rejected = [];
       try {
         fs.renameSync(${JSON.stringify(privateDir)}, ${JSON.stringify(privateDir + ".moved")});
         fs.renameSync(${JSON.stringify(privateDir + ".moved")}, ${JSON.stringify(privateDir)});
       } catch (error) { rejected.push(error.code); }
       try { fs.writeFileSync(${JSON.stringify(canary)}, "changed"); }
       catch (error) { rejected.push(error.code); }
       fs.writeFileSync(path.join(process.env.HOME, "model-file"), "home");
       fs.writeFileSync(path.join(process.env.TMPDIR, "scratch-file"), "temporary");
       if (${denyCleanup}) {
         const locked = path.join(process.env.TMPDIR, "locked");
         fs.mkdirSync(locked);
         fs.writeFileSync(path.join(locked, "data"), "temporary");
         fs.chmodSync(locked, 0);
       }
       writeArtifact(descriptor, "filesystem", { rejected, home: process.env.HOME, tmp: process.env.TMPDIR });`,
      );
      fs.writeFileSync(
        path.join(
          f.bundleRoot,
          input.gatewayNamespace,
          "bundles",
          input.expectedBundleHash,
          "worker.mjs",
        ),
        source,
      );
      let extinction: Promise<unknown> | undefined;
      let scratch: string | undefined;
      const capture = observeNodeWorkerAdapters((adapter) => {
        extinction = adapter.waitForExtinction?.();
        void extinction?.catch(() => undefined);
      });
      try {
        await f.supervisor.launch(input, TEST_WORKER_ENDPOINT);
        expect(await f.terminal(input.launchId)).toMatchObject({ state: "completed" });
        const proof = JSON.parse(
          fs.readFileSync(path.join(workspace, "filesystem-launch.filesystem.json"), "utf8"),
        );
        scratch = proof.tmp;
        expect(proof.rejected).toEqual(["EACCES", "EACCES"]);
        expect(fs.readFileSync(canary, "utf8")).toBe("original");
        expect(proof.home).toBe(path.join(home, "model-home"));
        expect(fs.readFileSync(path.join(proof.home, "model-file"), "utf8")).toBe("home");
        await f.supervisor.close();
        expect(extinction).toBeDefined();
        await expect(extinction).resolves.toBeUndefined();
        expect(fs.existsSync(proof.tmp)).toBe(denyCleanup && process.getuid?.() !== 0);
      } finally {
        await f.supervisor.close();
        capture.mockRestore();
        if (scratch && fs.existsSync(scratch)) {
          fs.chmodSync(path.join(scratch, "locked"), 0o700);
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      }
    },
  );

  it.each(["other-gateway", "next-epoch"])("rejects a workspace for %s", async (mismatch) => {
    const root = tempDirs.make("worker-placement-");
    await using f = createObservedNodeWorkerSupervisorFixture(root, {
      filesystemIsolation: true,
      env: { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state"), PATH: process.env.PATH },
    });
    const input = testWorkerLaunchInput(f.workspaceDir, "foreign-workspace");
    const { environmentId, sessionId, ownerEpoch } = input.descriptor.admission;
    const gateway = mismatch === "other-gateway" ? "other-gateway" : input.gatewayNamespace;
    const session = ensureNodeWorkerWorkspaceSessionRoot(
      f.bundleRoot,
      gateway,
      environmentId,
      sessionId,
    );
    input.descriptor.assignment.workspaceDir = path.join(
      session,
      String(mismatch === "next-epoch" ? ownerEpoch + 1 : ownerEpoch),
    );
    fs.mkdirSync(input.descriptor.assignment.workspaceDir);
    await f.supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(await f.terminal(input.launchId)).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("Worker writable storage cannot"),
    });
  });

  it("releases scratch when the target exits before its worker handshake", async () => {
    const root = tempDirs.make("worker-filesystem-failed-");
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    await using f = createObservedNodeWorkerSupervisorFixture(root, {
      filesystemIsolation: true,
      env: {
        OPENCLAW_STATE_DIR: path.join(root, "state-root"),
        HOME: home,
        PATH: process.env.PATH,
      },
    });
    const input = testWorkerLaunchInput(f.workspaceDir, "failed-filesystem-launch");
    const proofPath = f.file("failed-start.json");
    fs.writeFileSync(
      path.join(
        f.bundleRoot,
        input.gatewayNamespace,
        "bundles",
        input.expectedBundleHash,
        "worker.mjs",
      ),
      `import fs from "node:fs";
       fs.writeFileSync(${JSON.stringify(proofPath)}, JSON.stringify({ tmp: process.env.TMPDIR }));
       process.exit(23);`,
    );
    await f.supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(await f.terminal(input.launchId)).toMatchObject({ state: "failed" });
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    await f.supervisor.close();
    expect(fs.existsSync(proof.tmp)).toBe(false);
  });
});
