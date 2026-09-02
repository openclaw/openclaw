import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isRegisteredStagingDirectory,
  registerProducedStagingDirectory,
} from "../../media/staged-inputs.js";

const STAGED_INPUT_GITIGNORE =
  "# Raw task inputs remain private; copy outputs into the project to publish.\n*\n";

function getRegisteredStagingDirectoriesCount(): number {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.stagedInputsTestApi")
  ] as { getRegisteredStagingDirectoriesCount?: () => number } | undefined;
  return api?.getRegisteredStagingDirectoriesCount?.() ?? 0;
}
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../stage-sandbox-media.test-harness.js";
import { getReplyFromConfig } from "./get-reply.js";
import {
  cleanEmptyStagingDirectorySafely,
  cleanHostWorkspaceStaging,
  completeFollowupRunLifecycle,
  type FollowupRun,
} from "./queue/types.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

function getQueueDrainTestApi(): {
  releaseQueueSummaryDeliveryForRetry: (queue: unknown, delivery: unknown) => void;
} {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.queueDrainTestApi")
  ] as
    | { releaseQueueSummaryDeliveryForRetry: (queue: unknown, delivery: unknown) => void }
    | undefined;
  return api as ReturnType<typeof getQueueDrainTestApi>;
}

const checkExists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false);

function makeStageCfg(home: string) {
  // SAFETY: test config cast
  return {
    ...createSandboxMediaStageConfig(home),
    agents: { defaults: { sandbox: { mode: "off" } } },
  } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return false;
}

const waitForPathAbsence = (p: string, ms = 2000) =>
  waitForCondition(async () => !(await checkExists(p)), ms);

describe("stageSandboxMedia host staging lifecycle cleanup", () => {
  it("returns hostWorkspaceStagingDir and staged files remain readable after completeFollowupRunLifecycle (non-empty dir preserved)", async () => {
    await withSandboxMediaTempHome("staging-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample.jpg");
      await fs.writeFile(sampleFile, "test-media-content");

      const mediaUri = `media://inbound/sample.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-1",
        workspaceDir,
      });

      expect(result.staged.size).toBe(1);
      expect(result.hostWorkspaceStagingDir).toBeDefined();

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toContain("openclaw-staged-");

      // Verify staged file is readable before lifecycle
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const fileContent = await fs.readFile(stagedFilePath, "utf-8");
      expect(fileContent).toBe("test-media-content");

      registerProducedStagingDirectory(stagingDir);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      // Lifecycle cleanup: non-empty dir is preserved (staged files serve subsequent turns)
      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);

      // Reference is cleared immediately and registration is released
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);

      // Non-empty staging directory must still exist — staged files are needed for transcript replay
      const exists = await waitForCondition(async () => {
        return await fs
          .stat(stagingDir)
          .then(() => true)
          .catch(() => false);
      });
      expect(exists).toBe(true);

      // The staged file itself must remain readable
      const afterContent = await fs.readFile(stagedFilePath, "utf-8");
      expect(afterContent).toBe("test-media-content");
    });
  });

  it("cleans up empty staging directory when all copies fail (producer-owned residue removed at source)", async () => {
    await withSandboxMediaTempHome("failed-copy-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      // A directory at the attachment path makes the producer reach copyIn,
      // which can create an empty destination parent before rejecting it.
      const mediaUri = `media://inbound/missing.jpg`;
      await fs.mkdir(path.join(mediaDir, "missing.jpg"));
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-fail",
        workspaceDir,
      });

      // No successful stages → no cleanup owner exposed and no producer residue.
      expect(result.staged.size).toBe(0);
      expect(result.hostWorkspaceStagingDir).toBeUndefined();
      const stagingEntries = await fs
        .readdir(path.join(workspaceDir, "media", "inbound"))
        .catch(() => []);
      expect(stagingEntries.filter((entry) => entry.startsWith("openclaw-staged-")).length).toBe(0);
    });
  });

  it("cleans up staging directory when a turn is dropped directly on the active-run path", async () => {
    await withSandboxMediaTempHome("dropped-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample2.jpg");
      await fs.writeFile(sampleFile, "dropped-turn-media-content");

      const mediaUri = `media://inbound/sample2.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-2",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      registerProducedStagingDirectory(stagingDir);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);

      // Reference cleared immediately on drop and registration released
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);
      // Staged file content is preserved (drop does not delete file data)
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await waitForCondition(async () => {
        const text = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
        return text === "dropped-turn-media-content";
      });
      expect(content).toBe(true);
    });
  });

  it("cleans up staging directory on direct non-queued reply completion without firing queue abandonment callbacks", async () => {
    await withSandboxMediaTempHome("direct-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample3.jpg");
      await fs.writeFile(sampleFile, "direct-turn-media-content");

      const mediaUri = `media://inbound/sample3.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-3",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();
      registerProducedStagingDirectory(stagingDir);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      const onAbandoned = vi.fn();
      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
        turnAdoptionLifecycle: {
          onAdopted: vi.fn(),
          onAbandoned,
        } as unknown as FollowupRun["turnAdoptionLifecycle"],
      };

      // Direct cleanup (no queue involvement) clears the reference and releases registration
      cleanHostWorkspaceStaging(followupRun as unknown as FollowupRun);

      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);
      expect(onAbandoned).not.toHaveBeenCalled();

      // Staged files are preserved — non-empty dir is not deleted
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await waitForCondition(async () => {
        const text = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
        return text === "direct-turn-media-content";
      });
      expect(content).toBe(true);
    });
  });

  it("defers staging directory cleanup on pre-accepted message injection until active operation settlement", async () => {
    await withSandboxMediaTempHome("preaccepted-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(home, ".openclaw", "media", "inbound", "sample4.jpg");
      await fs.writeFile(sampleFile, "preaccepted-turn-media-content");

      const mediaUri = `media://inbound/sample4.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-4",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();
      registerProducedStagingDirectory(stagingDir);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      let resolveSettlement: (() => void) | undefined;
      const ownerSettlement = new Promise<void>((resolve) => {
        resolveSettlement = resolve;
      });

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      // Simulate pre-accepted injection transferring staging ownership to ownerSettlement
      const hostStagingDir = followupRun.hostWorkspaceStagingDir;
      delete followupRun.hostWorkspaceStagingDir;
      void ownerSettlement.then(() => {
        completeFollowupRunLifecycle({ hostWorkspaceStagingDir: hostStagingDir } as FollowupRun);
      });

      // Staged file must still be readable before settlement
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8");
      expect(content).toBe("preaccepted-turn-media-content");

      // Settle active operation — cleanup fires, registration released, non-empty dir stays (files preserved)
      resolveSettlement!();
      await ownerSettlement;

      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);

      // Dir still exists because staging was successful (non-empty)
      const exists = await waitForCondition(async () => {
        return await fs
          .stat(stagingDir)
          .then(() => true)
          .catch(() => false);
      });
      expect(exists).toBe(true);
    });
  });

  it("cleans up staging directory on skipped reply turn admission preparation exit", async () => {
    await withSandboxMediaTempHome("skipped-admission-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(home, ".openclaw", "media", "inbound", "sample5.jpg");
      await fs.writeFile(sampleFile, "skipped-admission-media-content");

      const mediaUri = `media://inbound/sample5.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-5",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();
      registerProducedStagingDirectory(stagingDir);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);

      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);
      // Staged files preserved even on skipped admission
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await waitForCondition(async () => {
        const text = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
        return text === "skipped-admission-media-content";
      });
      expect(content).toBe(true);
    });
  });

  it("cleans up staging directory on prepared reply early admission / queue-state short-circuit", async () => {
    await withSandboxMediaTempHome("short-circuit-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(home, ".openclaw", "media", "inbound", "sample6.jpg");
      await fs.writeFile(sampleFile, "short-circuit-media-content");

      const mediaUri = `media://inbound/sample6.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-6",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();
      registerProducedStagingDirectory(stagingDir);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      const runOpts: { hostWorkspaceStagingDir?: string } = {
        hostWorkspaceStagingDir: stagingDir,
      };

      cleanHostWorkspaceStaging(runOpts);

      // opts reference cleared after exit and registration released
      expect(runOpts.hostWorkspaceStagingDir).toBeUndefined();
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);
      // Staged files themselves are preserved
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
      expect(content).toBe("short-circuit-media-content");
    });
  });

  it("onHostStagingDelegated clears outer opts reference so post-handoff errors cannot delete active staged media", async () => {
    await withSandboxMediaTempHome("post-handoff-safety-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample.jpg");
      await fs.writeFile(sampleFile, "test-media-content");

      const mediaUri = `media://inbound/sample.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-handoff-test",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      registerProducedStagingDirectory(stagingDir);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      // Model the exact shape wired in get-reply.ts
      const outerOpts: {
        hostWorkspaceStagingDir?: string;
        onHostStagingDelegated?: () => void;
      } = {
        hostWorkspaceStagingDir: stagingDir,
        onHostStagingDelegated: () => {
          delete outerOpts.hostWorkspaceStagingDir;
        },
      };

      // Simulate executePreparedReplyRun taking ownership and calling the handoff callback
      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: outerOpts.hostWorkspaceStagingDir,
      };
      outerOpts.onHostStagingDelegated?.();

      // After handoff: outer reference is cleared, followupRun owns the dir
      expect(outerOpts.hostWorkspaceStagingDir).toBeUndefined();
      expect(followupRun.hostWorkspaceStagingDir).toBe(stagingDir);

      // Simulate a post-handoff error in the outer caller
      const caughtErr = await (async () => {
        try {
          if (outerOpts.hostWorkspaceStagingDir) {
            cleanHostWorkspaceStaging(outerOpts);
          }
          throw new Error("post-handoff error");
        } catch (err) {
          return err as Error;
        }
      })();
      expect(caughtErr.message).toBe("post-handoff error");

      // Staged file must still be readable — outer catch had no reference to delete it
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8");
      expect(content).toBe("test-media-content");

      // Lifecycle owner can still clean up (empty-dir rmdir attempt on non-empty dir is a no-op)
      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);
      const afterContent = await fs.readFile(stagedFilePath, "utf-8");
      expect(afterContent).toBe("test-media-content");
    });
  });

  it("removes empty staging directory on prepared reply early admission / queue-state short-circuit exit", async () => {
    await withSandboxMediaTempHome("empty-short-circuit-cleanup-test", async (home) => {
      const workspaceDir = path.join(home, "openclaw");
      const emptyStagingDir = path.join(
        workspaceDir,
        "media",
        "inbound",
        "openclaw-staged-11111111-1111-4111-8111-111111111111",
      );
      await fs.mkdir(emptyStagingDir, { recursive: true });
      await fs.writeFile(path.join(emptyStagingDir, ".gitignore"), STAGED_INPUT_GITIGNORE);
      registerProducedStagingDirectory(emptyStagingDir);
      expect(isRegisteredStagingDirectory(emptyStagingDir)).toBe(true);

      const runOpts: { hostWorkspaceStagingDir?: string } = {
        hostWorkspaceStagingDir: emptyStagingDir,
      };

      cleanHostWorkspaceStaging(runOpts);

      expect(runOpts.hostWorkspaceStagingDir).toBeUndefined();
      expect(isRegisteredStagingDirectory(emptyStagingDir)).toBe(false);

      // The empty staging directory must be completely removed from disk
      const removed = await waitForPathAbsence(emptyStagingDir);
      expect(removed).toBe(true);
    });
  });

  it("carries hostWorkspaceStagingDir to queue lifecycle on optionless reply handoff", async () => {
    await withSandboxMediaTempHome("optionless-handoff-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample-optionless.jpg");
      await fs.writeFile(sampleFile, "optionless-media-content");

      const mediaUri = `media://inbound/sample-optionless.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      const stageResult = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-optionless",
        workspaceDir,
      });

      const stagingDir = stageResult.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();
      registerProducedStagingDirectory(stagingDir);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      // When resolvedOpts is undefined (caller provided no opts), runner opts still inherits hostWorkspaceStagingDir
      let hostWorkspaceStagingDir: string | undefined = stageResult.hostWorkspaceStagingDir;
      const runnerOpts: {
        hostWorkspaceStagingDir?: string;
        onHostStagingDelegated?: () => void;
      } = {
        ...(hostWorkspaceStagingDir ? { hostWorkspaceStagingDir } : {}),
        onHostStagingDelegated: () => {
          hostWorkspaceStagingDir = undefined;
        },
      };

      expect(runnerOpts.hostWorkspaceStagingDir).toBe(stagingDir);

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: runnerOpts.hostWorkspaceStagingDir,
      };
      runnerOpts.onHostStagingDelegated?.();

      expect(hostWorkspaceStagingDir).toBeUndefined();
      expect(followupRun.hostWorkspaceStagingDir).toBe(stagingDir);

      // Settle lifecycle
      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);
    });
  });

  it("rejects foreign caller-supplied hostWorkspaceStagingDir in options and leaves foreign directory untouched", async () => {
    await withSandboxMediaTempHome("foreign-opts-rejection-test", async (home) => {
      const foreignDir = path.join(home, "foreign-user-dir");
      await fs.mkdir(foreignDir, { recursive: true });
      const userGitignore = path.join(foreignDir, ".gitignore");
      await fs.writeFile(userGitignore, "node_modules/\n.env\n");

      const runOpts: { hostWorkspaceStagingDir?: string } = {
        hostWorkspaceStagingDir: foreignDir,
      };

      cleanHostWorkspaceStaging(runOpts);

      expect(runOpts.hostWorkspaceStagingDir).toBeUndefined();

      // Foreign directory and its contents must remain completely intact
      const foreignDirExists = await fs
        .stat(foreignDir)
        .then(() => true)
        .catch(() => false);
      expect(foreignDirExists).toBe(true);
      const gitignoreContent = await fs.readFile(userGitignore, "utf-8");
      expect(gitignoreContent).toBe("node_modules/\n.env\n");
    });
  });

  it("cleanHostWorkspaceStaging rejects non-staging directory names and non-marker .gitignore files", async () => {
    await withSandboxMediaTempHome("cleaner-validation-test", async (home) => {
      // 1. Non-staging directory name
      const nonStagingDir = path.join(home, "arbitrary-folder");
      await fs.mkdir(nonStagingDir, { recursive: true });
      await fs.writeFile(path.join(nonStagingDir, ".gitignore"), "*\n");

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: nonStagingDir });

      const nonStagingExists = await fs
        .stat(nonStagingDir)
        .then(() => true)
        .catch(() => false);
      expect(nonStagingExists).toBe(true);

      // 2. Staging-shaped name but custom (non-marker) .gitignore
      const stagingDirWithCustomGitignore = path.join(
        home,
        "openclaw-staged-22222222-2222-4222-8222-222222222222",
      );
      await fs.mkdir(stagingDirWithCustomGitignore, { recursive: true });
      const customGitignorePath = path.join(stagingDirWithCustomGitignore, ".gitignore");
      await fs.writeFile(customGitignorePath, "build/\ndist/\n");

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: stagingDirWithCustomGitignore });

      expect(await waitForCondition(() => checkExists(stagingDirWithCustomGitignore))).toBe(true);
      const customContent = await fs.readFile(customGitignorePath, "utf-8");
      expect(customContent).toBe("build/\ndist/\n");

      // 3. Staging-shaped name with canonical marker but NOT producer-minted
      const unmintedStagingDir = path.join(
        home,
        "openclaw-staged-44444444-4444-4444-8444-444444444444",
      );
      await fs.mkdir(unmintedStagingDir, { recursive: true });
      const canonicalMarkerPath = path.join(unmintedStagingDir, ".gitignore");
      await fs.writeFile(canonicalMarkerPath, STAGED_INPUT_GITIGNORE);

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: unmintedStagingDir });

      expect(await waitForCondition(() => checkExists(unmintedStagingDir))).toBe(true);

      // 4. Producer-registered directory whose marker is altered to bare wildcard "*"
      const registeredBareStarDir = path.join(
        home,
        "openclaw-staged-66666666-6666-4666-8666-666666666666",
      );
      await fs.mkdir(registeredBareStarDir, { recursive: true });
      const bareStarMarkerPath = path.join(registeredBareStarDir, ".gitignore");
      await fs.writeFile(bareStarMarkerPath, "*");
      registerProducedStagingDirectory(registeredBareStarDir);

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: registeredBareStarDir });

      expect(await waitForCondition(() => checkExists(registeredBareStarDir))).toBe(true);
      expect(await checkExists(bareStarMarkerPath)).toBe(true);

      // 5. Producer-registered directory whose marker is altered to "*\n"
      const registeredBareStarNewlineDir = path.join(
        home,
        "openclaw-staged-77777777-7777-4777-8777-777777777777",
      );
      await fs.mkdir(registeredBareStarNewlineDir, { recursive: true });
      const bareStarNewlineMarkerPath = path.join(registeredBareStarNewlineDir, ".gitignore");
      await fs.writeFile(bareStarNewlineMarkerPath, "*\n");
      registerProducedStagingDirectory(registeredBareStarNewlineDir);

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: registeredBareStarNewlineDir });

      expect(await waitForCondition(() => checkExists(registeredBareStarNewlineDir))).toBe(true);
      expect(await checkExists(bareStarNewlineMarkerPath)).toBe(true);

      // 6. Registered staging path is a symlink pointing to an external directory with canonical marker
      const externalTargetDir = path.join(home, "external-target-dir");
      await fs.mkdir(externalTargetDir, { recursive: true });
      const externalMarkerPath = path.join(externalTargetDir, ".gitignore");
      await fs.writeFile(externalMarkerPath, STAGED_INPUT_GITIGNORE);

      const symlinkStagingDir = path.join(
        home,
        "openclaw-staged-88888888-8888-4888-8888-888888888888",
      );
      await fs.symlink(externalTargetDir, symlinkStagingDir, "dir");
      registerProducedStagingDirectory(symlinkStagingDir);

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: symlinkStagingDir });

      const symlinkStillExists = await waitForCondition(async () => {
        return await fs
          .lstat(symlinkStagingDir)
          .then((s) => s.isSymbolicLink())
          .catch(() => false);
      });
      expect(symlinkStillExists).toBe(true);
      expect(await checkExists(externalMarkerPath)).toBe(true);

      // 7. Registered staging directory containing a symlinked .gitignore marker
      const dirWithSymlinkMarker = path.join(
        home,
        "openclaw-staged-99999999-9999-4999-8999-999999999999",
      );
      await fs.mkdir(dirWithSymlinkMarker, { recursive: true });
      const externalSecretFile = path.join(home, "external-secret-file");
      await fs.writeFile(externalSecretFile, STAGED_INPUT_GITIGNORE);
      const symlinkMarkerPath = path.join(dirWithSymlinkMarker, ".gitignore");
      await fs.symlink(externalSecretFile, symlinkMarkerPath, "file");
      registerProducedStagingDirectory(dirWithSymlinkMarker);

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: dirWithSymlinkMarker });

      const dirWithSymlinkExists = await waitForCondition(async () => {
        return await fs
          .stat(dirWithSymlinkMarker)
          .then(() => true)
          .catch(() => false);
      });
      expect(dirWithSymlinkExists).toBe(true);
      const secretFileStillExists = await fs
        .stat(externalSecretFile)
        .then(() => true)
        .catch(() => false);
      expect(secretFileStillExists).toBe(true);

      // 8. cleanEmptyStagingDirectorySafely directly rejects symlinked staging directory
      await cleanEmptyStagingDirectorySafely(symlinkStagingDir);
      const directSymlinkExists = await fs
        .lstat(symlinkStagingDir)
        .then((s) => s.isSymbolicLink())
        .catch(() => false);
      expect(directSymlinkExists).toBe(true);

      // 9. cleanEmptyStagingDirectorySafely directly rejects symlinked marker
      await cleanEmptyStagingDirectorySafely(dirWithSymlinkMarker);
      const directSecretExists = await fs
        .stat(externalSecretFile)
        .then(() => true)
        .catch(() => false);
      expect(directSecretExists).toBe(true);

      // 10. cleanEmptyStagingDirectorySafely directly rejects markerless directory
      const markerlessDir = path.join(home, "openclaw-staged-dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      await fs.mkdir(markerlessDir, { recursive: true });
      await cleanEmptyStagingDirectorySafely(markerlessDir);
      const markerlessDirStillExists = await fs
        .stat(markerlessDir)
        .then(() => true)
        .catch(() => false);
      expect(markerlessDirStillExists).toBe(true);
    });
  });

  it("cleanEmptyStagingDirectorySafely protects against forced post-validation symlink swap race", async () => {
    await withSandboxMediaTempHome("post-val-swap-test", async (home) => {
      // Create external directory with critical marker file
      const externalDir = path.join(home, "external-critical-dir");
      await fs.mkdir(externalDir, { recursive: true });
      const externalMarker = path.join(externalDir, ".gitignore");
      await fs.writeFile(externalMarker, STAGED_INPUT_GITIGNORE);

      // Create genuine staging directory with marker
      const stagingDir = path.join(home, "openclaw-staged-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);

      // Hook fs.readdir to simulate an adversarial process swapping the validated
      // directory to a symlink pointing to externalDir immediately after directory validation
      const realReaddir = fs.readdir;
      let swapped = false;
      const readdirSpy = vi
        .spyOn(fs, "readdir")
        .mockImplementation(async (...args: Parameters<typeof realReaddir>) => {
          const result = await realReaddir(...args);
          if (args[0] === stagingDir && !swapped) {
            swapped = true;
            // Forced post-validation directory swap:
            // Remove stagingDir and replace with symlink to externalDir
            await fs.rm(stagingDir, { recursive: true });
            await fs.symlink(externalDir, stagingDir, "dir");
          }
          return result;
        });

      try {
        await cleanEmptyStagingDirectorySafely(stagingDir);
      } finally {
        readdirSpy.mockRestore();
      }

      expect(swapped).toBe(true);

      // The external marker MUST remain intact and untouched
      const externalMarkerStillExists = await fs
        .stat(externalMarker)
        .then(() => true)
        .catch(() => false);
      expect(externalMarkerStillExists).toBe(true);
      const externalMarkerContent = await fs.readFile(externalMarker, "utf8");
      expect(externalMarkerContent).toBe(STAGED_INPUT_GITIGNORE);
    });
  });

  it("cleanEmptyStagingDirectorySafely protects against forced symlink swap between marker verification and deletion", async () => {
    await withSandboxMediaTempHome("post-marker-read-swap-test", async (home) => {
      const externalDir = path.join(home, "external-critical-dir-2");
      await fs.mkdir(externalDir, { recursive: true });
      const externalMarker = path.join(externalDir, ".gitignore");
      await fs.writeFile(externalMarker, STAGED_INPUT_GITIGNORE);

      const stagingDir = path.join(home, "openclaw-staged-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);

      // Hook fs.open to swap the directory after the marker file has been opened
      const realOpen = fs.open;
      let swapped = false;
      const openSpy = vi
        .spyOn(fs, "open")
        .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
          const result = await realOpen(...args);
          if (typeof args[0] === "string" && args[0].includes(stagingDir) && !swapped) {
            swapped = true;
            // Forced swap right between marker open and deletion:
            await fs.rm(stagingDir, { recursive: true });
            await fs.symlink(externalDir, stagingDir, "dir");
          }
          return result;
        });

      try {
        await cleanEmptyStagingDirectorySafely(stagingDir);
      } finally {
        openSpy.mockRestore();
      }

      expect(swapped).toBe(true);
      // The external marker MUST remain intact and untouched
      expect(await checkExists(externalMarker)).toBe(true);
      const externalMarkerContent = await fs.readFile(externalMarker, "utf8");
      expect(externalMarkerContent).toBe(STAGED_INPUT_GITIGNORE);
    });
  });

  it("cleanEmptyStagingDirectorySafely protects against forced parent-directory symlink swap before final removal", async () => {
    await withSandboxMediaTempHome("post-val-parent-swap-test", async (home) => {
      // Create external directory with same-named target directory that should never be deleted
      const externalParent = path.join(home, "external-parent-dir");
      await fs.mkdir(externalParent, { recursive: true });
      const stagingDirName = "openclaw-staged-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const externalVictimDir = path.join(externalParent, stagingDirName);
      await fs.mkdir(externalVictimDir, { recursive: true });

      // Create genuine staging parent directory and staging directory with marker
      const stagingParent = path.join(home, "media-inbound");
      await fs.mkdir(stagingParent, { recursive: true });
      const stagingDir = path.join(stagingParent, stagingDirName);
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);

      // Hook fs.lstat to swap stagingParent to a symlink pointing to externalParent
      // right after marker removal and before the final removal
      let swapped = false;
      const realLstat = fs.lstat;
      const lstatSpy = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (...args: Parameters<typeof realLstat>) => {
          const result = await realLstat(...args);
          // When finalStat is queried on hostWorkspaceStagingDir after marker removal,
          // swap the parent directory to a symlink to externalParent
          if (args[0] === stagingDir && !swapped) {
            const files = await fs.readdir(stagingDir).catch(() => null);
            if (files && files.length === 0) {
              swapped = true;
              await fs.rm(stagingParent, { recursive: true });
              await fs.symlink(externalParent, stagingParent, "dir");
            }
          }
          return result;
        });

      try {
        await cleanEmptyStagingDirectorySafely(stagingDir);
      } finally {
        lstatSpy.mockRestore();
      }

      expect(swapped).toBe(true);

      // The external victim directory inside externalParent MUST NOT be deleted!
      expect(await checkExists(externalVictimDir)).toBe(true);
    });
  });

  it("cleanEmptyStagingDirectorySafely rejects markerless replacement directory and leaves it intact", async () => {
    await withSandboxMediaTempHome("markerless-replacement-test", async (home) => {
      const stagingDir = path.join(home, "openclaw-staged-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
      // Create empty markerless directory shaped like an OpenClaw staging directory
      await fs.mkdir(stagingDir, { recursive: true });

      // Cleaner must refuse to delete it because it lacks the canonical ownership marker
      await cleanEmptyStagingDirectorySafely(stagingDir);

      expect(await checkExists(stagingDir)).toBe(true);
    });
  });

  it("cleanEmptyStagingDirectorySafely preserves and restores canonical marker if directory removal loses a concurrent write race", async () => {
    await withSandboxMediaTempHome("concurrent-write-race-test", async (home) => {
      const stagingParent = path.join(home, "media-inbound");
      await fs.mkdir(stagingParent, { recursive: true });
      const stagingDirName = "openclaw-staged-ffffffff-ffff-4fff-8fff-ffffffffffff";
      const stagingDir = path.join(stagingParent, stagingDirName);
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);

      // Hook fs.rm (which deletes .gitignore) to simulate a concurrent workspace writer
      // creating a new media file immediately after marker deletion and before directory removal
      let raced = false;
      const realRm = fs.rm;
      const rmSpy = vi
        .spyOn(fs, "rm")
        .mockImplementation(async (...args: Parameters<typeof realRm>) => {
          const res = await realRm(...args);
          if (typeof args[0] === "string" && args[0].endsWith(".gitignore") && !raced) {
            raced = true;
            // Concurrent writer creates a media file before parentRoot.remove(dirName) runs:
            await fs.writeFile(path.join(stagingDir, "concurrent-inbound-media.jpg"), "photo-data");
          }
          return res;
        });

      try {
        await cleanEmptyStagingDirectorySafely(stagingDir);
      } finally {
        rmSpy.mockRestore();
      }

      expect(raced).toBe(true);

      // The directory survived because it was non-empty:
      expect(await checkExists(stagingDir)).toBe(true);
      // The concurrent media file must remain intact:
      expect(await checkExists(path.join(stagingDir, "concurrent-inbound-media.jpg"))).toBe(true);
      // CRITICAL: The canonical ownership marker MUST have been restored!
      expect(await checkExists(stagingMarker)).toBe(true);
      const markerContent = await fs.readFile(stagingMarker, "utf8");
      expect(markerContent).toBe(STAGED_INPUT_GITIGNORE);
    });
  });

  it("cleanEmptyStagingDirectorySafely preserves and restores late-written media to canonical path if written after empty check", async () => {
    await withSandboxMediaTempHome("late-concurrent-write-test", async (home) => {
      const stagingParent = path.join(home, "media-inbound");
      await fs.mkdir(stagingParent, { recursive: true });
      const stagingDirName = "openclaw-staged-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const stagingDir = path.join(stagingParent, stagingDirName);
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);

      let lateWritten = false;
      const hookKey = Symbol.for("openclaw.fsSafeBeforeDeletionEffectHook");
      // SAFETY: test hook registration
      (globalThis as Record<PropertyKey, unknown>)[hookKey] = async (
        _targetDir: string,
        isolatedPath?: string,
      ) => {
        if (isolatedPath && !lateWritten) {
          lateWritten = true;
          // Simulate late writer placing new staged media into the directory after emptiness check:
          await fs.writeFile(
            path.join(isolatedPath, "late-inbound-media.png"),
            "late-staged-content",
          );
        }
      };

      try {
        await cleanEmptyStagingDirectorySafely(stagingDir);
      } finally {
        // SAFETY: test hook cleanup
        delete (globalThis as Record<PropertyKey, unknown>)[hookKey];
      }

      expect(lateWritten).toBe(true);

      // Late-written media must be restored back to the canonical staging path, NOT left in private isolation!
      expect(await checkExists(stagingDir)).toBe(true);
      const mediaPath = path.join(stagingDir, "late-inbound-media.png");
      expect(await checkExists(mediaPath)).toBe(true);
      expect(await fs.readFile(mediaPath, "utf8")).toBe("late-staged-content");

      // Canonical .gitignore marker must be restored on the preserved directory:
      expect(await checkExists(stagingMarker)).toBe(true);
    });
  });

  it("cleanEmptyStagingDirectorySafely handles two-writer recovery collision when late write occurs and targetPath is concurrently recreated", async () => {
    await withSandboxMediaTempHome("two-writer-collision-test", async (home) => {
      const stagingParent = path.join(home, "media-inbound");
      await fs.mkdir(stagingParent, { recursive: true });
      const stagingDirName = "openclaw-staged-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const stagingDir = path.join(stagingParent, stagingDirName);
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);

      let collided = false;
      const hookKey = Symbol.for("openclaw.fsSafeBeforeDeletionEffectHook");
      // SAFETY: test hook registration
      (globalThis as Record<PropertyKey, unknown>)[hookKey] = async (
        targetDir: string,
        isolatedPath?: string,
      ) => {
        if (isolatedPath && !collided) {
          collided = true;
          // Actor 1: Writes late media into isolatedPath:
          await fs.writeFile(path.join(isolatedPath, "actor1-late-media.png"), "actor1-content");
          // Actor 2: Concurrently recreates targetPath with its own media:
          await fs.mkdir(targetDir);
          await fs.writeFile(path.join(targetDir, "actor2-concurrent.jpg"), "actor2-content");
        }
      };

      try {
        await cleanEmptyStagingDirectorySafely(stagingDir);
      } finally {
        // SAFETY: test hook cleanup
        delete (globalThis as Record<PropertyKey, unknown>)[hookKey];
      }

      expect(collided).toBe(true);

      // Both late-written original media and recreated target media must be safe at canonical path:
      expect(await checkExists(stagingDir)).toBe(true);
      const actor1Path = path.join(stagingDir, "actor1-late-media.png");
      const actor2Path = path.join(stagingDir, "actor2-concurrent.jpg");
      expect(await checkExists(actor1Path)).toBe(true);
      expect(await fs.readFile(actor1Path, "utf8")).toBe("actor1-content");
      expect(await checkExists(actor2Path)).toBe(true);
      expect(await fs.readFile(actor2Path, "utf8")).toBe("actor2-content");

      // Canonical .gitignore marker must be restored on the preserved directory:
      expect(await checkExists(stagingMarker)).toBe(true);
    });
  });

  it("cleanEmptyStagingDirectorySafely preserves colliding same-basename late media during restoration without overwriting peer files", async () => {
    await withSandboxMediaTempHome("same-basename-collision-test", async (home) => {
      const stagingParent = path.join(home, "media-inbound");
      await fs.mkdir(stagingParent, { recursive: true });
      const stagingDirName = "openclaw-staged-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const stagingDir = path.join(stagingParent, stagingDirName);
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);

      let collided = false;
      const hookKey = Symbol.for("openclaw.fsSafeBeforeDeletionEffectHook");
      // SAFETY: test hook registration
      (globalThis as Record<PropertyKey, unknown>)[hookKey] = async (
        targetDir: string,
        isolatedPath?: string,
      ) => {
        if (isolatedPath && !collided) {
          collided = true;
          // Actor 1: Writes late media with filename "photo.jpg" into isolatedPath
          await fs.writeFile(path.join(isolatedPath, "photo.jpg"), "actor1-original-media");
          // Actor 2: Concurrently recreates targetDir with the EXACT SAME basename "photo.jpg"
          await fs.mkdir(targetDir);
          await fs.writeFile(path.join(targetDir, "photo.jpg"), "actor2-peer-media");
        }
      };

      try {
        await cleanEmptyStagingDirectorySafely(stagingDir);
      } finally {
        // SAFETY: test hook cleanup
        delete (globalThis as Record<PropertyKey, unknown>)[hookKey];
      }

      expect(collided).toBe(true);

      // Recreated staging directory must survive:
      expect(await checkExists(stagingDir)).toBe(true);

      // Actor 2's peer file must NOT be overwritten:
      const peerFile = path.join(stagingDir, "photo.jpg");
      expect(await checkExists(peerFile)).toBe(true);
      expect(await fs.readFile(peerFile, "utf8")).toBe("actor2-peer-media");

      // Actor 1's late-written media MUST be preserved at the canonical staging directory under non-colliding name:
      const dirEntries = await fs.readdir(stagingDir);
      const restoredEntry = dirEntries.find(
        (e) => e.startsWith("photo-restored-") && e.endsWith(".jpg"),
      );
      expect(restoredEntry).toBeDefined();
      expect(await fs.readFile(path.join(stagingDir, restoredEntry!), "utf8")).toBe(
        "actor1-original-media",
      );

      // Canonical .gitignore marker must be restored on the surviving directory:
      expect(await checkExists(stagingMarker)).toBe(true);
      expect(await fs.readFile(stagingMarker, "utf8")).toBe(STAGED_INPUT_GITIGNORE);
    });
  });

  it("getReplyFromConfig rejects caller-supplied hostWorkspaceStagingDir options even if shaped like UUID with canonical marker", async () => {
    await withSandboxMediaTempHome("public-opts-forged-test", async (home) => {
      const forgedDir = path.join(home, "openclaw-staged-55555555-5555-4555-8555-555555555555");
      await fs.mkdir(forgedDir, { recursive: true });
      const markerPath = path.join(forgedDir, ".gitignore");
      await fs.writeFile(markerPath, STAGED_INPUT_GITIGNORE);

      const cfg = makeStageCfg(home) as unknown as Parameters<typeof getReplyFromConfig>[2];

      const ctx = {
        Body: "test forged options",
        SessionKey: "forged-opts-session",
      } as Parameters<typeof getReplyFromConfig>[0];

      // Pass forged hostWorkspaceStagingDir via GetReplyOptions
      const opts = {
        hostWorkspaceStagingDir: forgedDir,
      } as unknown as Parameters<typeof getReplyFromConfig>[1];

      await getReplyFromConfig(ctx, opts, cfg).catch(() => {});

      // Forged directory must remain completely untouched
      const forgedExists = await waitForCondition(async () => {
        return await fs
          .stat(forgedDir)
          .then(() => true)
          .catch(() => false);
      });
      expect(forgedExists).toBe(true);
      const markerExists = await fs
        .stat(markerPath)
        .then(() => true)
        .catch(() => false);
      expect(markerExists).toBe(true);
    });
  });

  it("direct and non-auto-reply stageSandboxMedia callers do not leak registry entries", async () => {
    await withSandboxMediaTempHome("no-registry-leak-test", async (home) => {
      const initialCount = getRegisteredStagingDirectoriesCount();

      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample.jpg");
      await fs.writeFile(sampleFile, "sibling-media-content");

      const mediaUri = `media://inbound/sample.jpg`;
      const cfg = makeStageCfg(home);
      const workspaceDir = path.join(home, "openclaw");

      // Repeatedly stage through non-auto-reply caller
      for (let i = 0; i < 5; i++) {
        const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
        const result = await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: `sibling-session-${i}`,
          workspaceDir,
        });
        expect(result.hostWorkspaceStagingDir).toBeDefined();
      }

      // No entries should be added to the registry
      expect(getRegisteredStagingDirectoriesCount()).toBe(initialCount);
    });
  });

  it("direct reply execution releases staging directory from registry and cleans empty directory", async () => {
    await withSandboxMediaTempHome("direct-reply-registry-test", async (home) => {
      const initialCount = getRegisteredStagingDirectoriesCount();

      const stagingDir = path.join(home, "openclaw-staged-11111111-2222-4333-8444-555555555555");
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.writeFile(path.join(stagingDir, ".gitignore"), STAGED_INPUT_GITIGNORE);
      registerProducedStagingDirectory(stagingDir);

      expect(getRegisteredStagingDirectoriesCount()).toBe(initialCount + 1);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: stagingDir });

      // Registry entry must be released
      expect(getRegisteredStagingDirectoriesCount()).toBe(initialCount);
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);

      // Empty staging directory must be removed
      const absent = await waitForPathAbsence(stagingDir);
      expect(absent).toBe(true);
    });
  });

  it("cleanEmptyStagingDirectorySafely preserves replacement directory if leaf is swapped after final identity validation", async () => {
    await withSandboxMediaTempHome("leaf-swap-race-test", async (home) => {
      const stagingParent = path.join(home, "media-inbound");
      await fs.mkdir(stagingParent, { recursive: true });
      const stagingDirName = "openclaw-staged-12345678-1234-4234-8234-1234567890ab";
      const stagingDir = path.join(stagingParent, stagingDirName);
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);

      // Hook immediately before terminal removal (after final validation has confirmed the original directory):
      let swapped = false;
      const hookKey = Symbol.for("openclaw.stagingCleanupBeforeRemovalHook");
      // SAFETY: test hook registration
      (globalThis as Record<PropertyKey, unknown>)[hookKey] = async (targetDir: string) => {
        if (targetDir === stagingDir && !swapped) {
          swapped = true;
          // Replace the validated empty directory with a fresh empty directory
          // Consume the freed inode with a temporary filler so the replacement receives a distinct inode
          await fs.rmdir(stagingDir).catch(() => {});
          const filler = path.join(stagingParent, "inode-filler");
          await fs.mkdir(filler);
          await fs.mkdir(stagingDir);
          await fs.rmdir(filler);
        }
      };

      try {
        await cleanEmptyStagingDirectorySafely(stagingDir);
      } finally {
        // SAFETY: test hook cleanup
        delete (globalThis as Record<PropertyKey, unknown>)[hookKey];
      }

      expect(swapped).toBe(true);

      // The replacement directory MUST NOT be deleted because expected-leaf identity validation
      // at the deletion primitive detects the replacement inode mismatch and leaves it intact at its original path!
      const replacementStillExists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
      expect(replacementStillExists).toBe(true);
    });
  });

  it("releaseQueueSummaryDeliveryForRetry transfers staging ownership to retry clone so old source does not unregister it", async () => {
    await withSandboxMediaTempHome("overflow-retry-ownership-test", async (home) => {
      const stagingParent = path.join(home, "media-inbound");
      await fs.mkdir(stagingParent, { recursive: true });
      const stagingDirName = "openclaw-staged-11223344-5566-4777-8899-aabbccddeeff";
      const stagingDir = path.join(stagingParent, stagingDirName);
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingMarker = path.join(stagingDir, ".gitignore");
      await fs.writeFile(stagingMarker, STAGED_INPUT_GITIGNORE);
      registerProducedStagingDirectory(stagingDir);

      // SAFETY: test followup run cast
      const sourceRun = {
        prompt: "overflow summary item",
        hostWorkspaceStagingDir: stagingDir,
      } as unknown as FollowupRun;

      const queue = {
        summarySources: [sourceRun],
        summaryLines: ["overflow summary item"],
        droppedCount: 0,
      };

      const delivery = {
        sources: [sourceRun],
        summary: "overflow summary item",
        summaryLineCount: 1,
      };

      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);

      // Release summary delivery for retry:
      getQueueDrainTestApi().releaseQueueSummaryDeliveryForRetry(queue, delivery);

      // The old source must have surrendered ownership (property deleted)
      expect(sourceRun.hostWorkspaceStagingDir).toBeUndefined();

      // The cloned retry source in queue.summarySources must now own the staging directory
      expect(queue.summarySources[0]?.hostWorkspaceStagingDir).toBe(stagingDir);

      // Crucially, the staging directory MUST STILL BE REGISTERED in the registry!
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(true);
      expect(await checkExists(stagingDir)).toBe(true);

      // When the retry clone later completes its lifecycle, it must successfully clean and unregister:
      if (queue.summarySources[0]) {
        completeFollowupRunLifecycle(queue.summarySources[0]);
      }
      expect(isRegisteredStagingDirectory(stagingDir)).toBe(false);
      expect(await waitForPathAbsence(stagingDir)).toBe(true);
    });
  });
});
