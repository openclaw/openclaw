import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enqueueCommandInLane, getTotalQueueSize } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  getGatewayRestartDrainSignal,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { WizardSession } from "../../wizard/session.js";
import * as setupMigration from "../../wizard/setup.migration-snapshot.js";
import { GatewayConnectionWork } from "../server-connection-work.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({ stateDir: "" }));

vi.mock("../../config/paths.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/paths.js")>("../../config/paths.js")),
  resolveStateDir: () => mocks.stateDir,
}));

import {
  createAdmittedWizardSession,
  runExclusiveSystemAgentSetupActivation,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";

describe("setup admission", () => {
  beforeEach(() => {
    mocks.stateDir = tempDirs.make("openclaw-setup-admission-");
  });

  afterEach(() => {
    resetCommandQueueStateForTest();
    resetGatewayWorkAdmission();
  });

  it("retains root work for post-start session continuations", async () => {
    const continueAfterStart = createDeferred();
    let runner: Promise<void> | undefined;

    const session = await runWithGatewayIndependentRootWorkAdmission(async () =>
      createAdmittedWizardSession(() => {
        runner = (async () => {
          await continueAfterStart.promise;
          await enqueueCommandInLane("setup-post-start-proof", async () => undefined);
        })();
        return new WizardSession(() => runner!);
      }),
    );

    const activeAfterStart = getActiveGatewayRootWorkCount();
    continueAfterStart.resolve();
    await expect(runner).resolves.toBeUndefined();
    expect(activeAfterStart).toBe(1);
    await whenAdmittedWizardSessionSettled(session!);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(["process drain", "server close"])(
    "settles an abandoned prompt before %s releases its runtime",
    async (closing) => {
      const work = new GatewayConnectionWork();
      const disconnected = work.registerConnection(() => {});
      const cleanupStarted = createDeferred();
      const finishCleanup = createDeferred();
      const session = await work.track(() =>
        runWithGatewayIndependentRootWorkAdmission(() =>
          createAdmittedWizardSession(
            () =>
              new WizardSession(async (prompter) => {
                await enqueueCommandInLane("setup-shutdown-proof", async () => {
                  try {
                    await prompter.text({ message: "Local model base URL" });
                  } finally {
                    cleanupStarted.resolve();
                    await finishCleanup.promise;
                  }
                });
              }),
          ),
        ),
      );
      if (!session) {
        throw new Error("expected an admitted wizard");
      }
      try {
        expect((await session.next()).step?.type).toBe("text");
        disconnected();
        expect(session.getStatus()).toBe("running");
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(getTotalQueueSize()).toBe(1);

        if (closing === "process drain") {
          markGatewayRestartDraining();
        } else {
          work.beginClose();
        }
        expect(session.signal.aborted).toBe(true);
        await cleanupStarted.promise;
        expect(session.getStatus()).not.toBe("cancelled");
        expect(session.cancel()).toBe(false);
        expect(session.isSettled()).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(getTotalQueueSize()).toBe(1);
        await expect(runExclusiveSystemAgentSetupActivation(async () => {})).rejects.toThrow(
          "setup is already in progress",
        );
        let drained = false;
        const drain = work.drain().then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);

        finishCleanup.resolve();
        await whenAdmittedWizardSessionSettled(session);
        await drain;
        expect(await session.next()).toMatchObject({ done: true, status: "error" });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(getTotalQueueSize()).toBe(0);
        await expect(runExclusiveSystemAgentSetupActivation(async () => "released")).resolves.toBe(
          "released",
        );
      } finally {
        disconnected();
        session.cancel();
        finishCleanup.resolve();
        await whenAdmittedWizardSessionSettled(session);
        await work.drain();
      }
    },
  );

  it.each([
    ["already waiting", "outro"],
    ["after write", "outro"],
    ["already waiting", "confirm"],
    ["after write", "confirm"],
  ] as const)(
    "preserves committed work and ends unavailable %s %s at shutdown",
    async (when, prompt) => {
      const finishWrite = createDeferred();
      const prompting = createDeferred();
      let written = false;
      let answered = false;
      const session = await runWithGatewayIndependentRootWorkAdmission(() =>
        createAdmittedWizardSession(
          () =>
            new WizardSession(async (prompter, _signal, owner) => {
              owner.lockCancellation();
              await finishWrite.promise;
              written = true;
              prompting.resolve();
              if (prompt === "outro") {
                await prompter.outro("Channels updated.");
              } else {
                await prompter.confirm({
                  message: "Configure another account?",
                  initialValue: true,
                });
              }
              answered = true;
            }),
        ),
      );
      if (!session) {
        throw new Error("expected an admitted wizard");
      }
      try {
        if (when === "already waiting") {
          finishWrite.resolve();
          await prompting.promise;
        }
        markGatewayRestartDraining();
        expect(session.signal.aborted).toBe(false);
        expect(session.getStatus()).not.toBe("cancelled");
        if (when === "after write") {
          expect(written).toBe(false);
          expect(session.isSettled()).toBe(false);
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          finishWrite.resolve();
          await prompting.promise;
        }
        expect(session.getCurrentStep()).toBeUndefined();
        await whenAdmittedWizardSessionSettled(session);
        expect(written).toBe(true);
        expect(answered).toBe(false);
        expect(await session.next()).toMatchObject({ done: true, status: "error" });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        finishWrite.resolve();
        await prompting.promise;
        const pending = session.getCurrentStep();
        if (pending) {
          await session.answer(pending.id, undefined);
        }
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  );

  it.each(["credentials", "provider note", "final commit"])(
    "finishes the protected preparation artifact but stops before %s after shutdown",
    async (checkpoint) => {
      const finishArtifact = createDeferred();
      const artifactPath = path.join(mocks.stateDir, "reviewed-provider.txt");
      let promoted = false;
      const session = await runWithGatewayIndependentRootWorkAdmission(() =>
        createAdmittedWizardSession(
          () =>
            new WizardSession(async (prompter, signal, owner) => {
              owner.lockCancellationForPreparation();
              await finishArtifact.promise;
              signal.throwIfAborted();
              await fs.writeFile(artifactPath, "reviewed fixture artifact");
              if (checkpoint === "credentials") {
                await prompter.text({ message: "Provider API key", sensitive: true });
              } else if (checkpoint === "provider note") {
                await prompter.note("Provider installed. Continue to connect your account.");
              }
              owner.lockCancellation();
              promoted = true;
              owner.setPreparedModelRef("fixture/demo-model");
            }),
        ),
      );
      if (!session) {
        throw new Error("expected an admitted wizard");
      }
      try {
        markGatewayRestartDraining();
        expect(session.signal.aborted).toBe(false);
        expect(session.cancel()).toBe(false);
        expect(session.isSettled()).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        finishArtifact.resolve();
        await whenAdmittedWizardSessionSettled(session);
        expect(await fs.readFile(artifactPath, "utf8")).toBe("reviewed fixture artifact");
        expect(promoted).toBe(false);
        expect(session.signal.aborted).toBe(true);
        expect(session.getCurrentStep()).toBeUndefined();
        const done = await session.next();
        expect(done).toMatchObject({
          done: true,
          status: "error",
          error: expect.stringContaining("Gateway is shutting down"),
        });
        expect(done).not.toHaveProperty("preparedModelRef");
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        finishArtifact.resolve();
        const pending = session.getCurrentStep();
        if (pending) {
          await session.answer(pending.id, "fixture-cleanup");
        }
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  );

  it("keeps a prompt resumable across disconnect and reversible admission fences", async () => {
    const work = new GatewayConnectionWork();
    const disconnect = work.registerConnection(() => {});
    let submitted: string | undefined;
    const session = await work.track(() =>
      createAdmittedWizardSession(
        () =>
          new WizardSession(async (prompter) => {
            submitted = await prompter.text({ message: "Local model base URL" });
          }),
      ),
    );
    if (!session) {
      throw new Error("expected an admitted wizard");
    }
    try {
      const step = (await session.next()).step;
      if (!step) {
        throw new Error("expected a pending prompt");
      }
      disconnect();
      expect(beginGatewayRestartSignalAdmission()?.rollback()).toBe(true);
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      expect(suspension?.release()).toBe(true);
      expect(session.signal.aborted).toBe(false);
      expect((await session.next()).step?.id).toBe(step.id);
      await session.answer(step.id, "http://127.0.0.1:11434");
      await whenAdmittedWizardSessionSettled(session);
      expect(submitted).toBe("http://127.0.0.1:11434");
      expect(session.getStatus()).toBe("done");
    } finally {
      disconnect();
      session.cancel();
      await whenAdmittedWizardSessionSettled(session);
      await work.drain();
    }
  });

  it.each([false, true])(
    "does not construct a wizard after drain wins target-lock acquisition (reset=%s)",
    async (reset) => {
      const create = vi.fn(() => new WizardSession(async () => {}));
      const pending = createAdmittedWizardSession(create);
      const rejected = expect(pending).rejects.toThrow(
        "Gateway is restarting. Please try again shortly.",
      );
      markGatewayRestartDraining();
      if (reset) {
        resetGatewayWorkAdmission();
      }
      await rejected;
      expect(create).not.toHaveBeenCalled();
      resetGatewayWorkAdmission();
      const fresh = await createAdmittedWizardSession(create);
      expect(fresh).toBeDefined();
      await whenAdmittedWizardSessionSettled(fresh!);
    },
  );

  it.each([false, true])(
    "preserves committed work's result without further input (failure=%s)",
    async (failWrite) => {
      const finishWrite = createDeferred();
      const session = await createAdmittedWizardSession(
        () =>
          new WizardSession(async (_prompter, _signal, owner) => {
            owner.lockCancellation();
            await finishWrite.promise;
            if (failWrite) {
              throw new Error("settings write failed");
            }
            owner.setModelActivation({ modelRef: "ollama/local-model" });
          }),
      );
      if (!session) {
        throw new Error("expected an admitted wizard");
      }
      try {
        markGatewayRestartDraining();
        expect(session.signal.aborted).toBe(false);
        finishWrite.resolve();
        await whenAdmittedWizardSessionSettled(session);
        expect(await session.next()).toMatchObject({
          done: true,
          ...(failWrite
            ? { status: "error", error: "settings write failed" }
            : { status: "done", modelActivation: { modelRef: "ollama/local-model" } }),
        });
      } finally {
        finishWrite.resolve();
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  );

  it("keeps shutdown error provenance when a provider maps closed input to cancellation", async () => {
    const session = await createAdmittedWizardSession(
      () =>
        new WizardSession(async (prompter, _signal, owner) => {
          owner.lockCancellation();
          try {
            await prompter.text({ message: "Provider sign-in code" });
          } catch {
            throw new WizardCancelledError("provider input cancelled");
          }
        }),
    );
    if (!session) {
      throw new Error("expected an admitted wizard");
    }
    try {
      await session.next();
      markGatewayRestartDraining();
      await whenAdmittedWizardSessionSettled(session);
      expect(await session.next()).toMatchObject({
        done: true,
        status: "error",
        error: expect.stringContaining("Gateway is shutting down"),
      });
    } finally {
      const pending = session.getCurrentStep();
      if (pending) {
        await session.answer(pending.id, undefined);
      }
      await whenAdmittedWizardSessionSettled(session);
    }
  });

  it.each([false, true])(
    "releases its drain listener and root even when target-lock cleanup fails (%s)",
    async (failCleanup) => {
      const finish = createDeferred();
      const drainSignal = getGatewayRestartDrainSignal();
      const priorListeners = getEventListeners(drainSignal, "abort").length;
      const releaseError = new Error("target-lock release failed");
      const lock = failCleanup
        ? vi
            .spyOn(setupMigration, "withSetupMigrationTargetLock")
            .mockImplementationOnce(async (_stateDir, run) => {
              await run();
              throw releaseError;
            })
        : undefined;
      let session: WizardSession | undefined;
      try {
        session = await runWithGatewayIndependentRootWorkAdmission(() =>
          createAdmittedWizardSession(() => new WizardSession(() => finish.promise)),
        );
        if (!session) {
          throw new Error("expected an admitted wizard");
        }
        expect(getEventListeners(drainSignal, "abort")).toHaveLength(priorListeners + 1);
        finish.resolve();
        const settlement = whenAdmittedWizardSessionSettled(session);
        if (failCleanup) {
          await expect(settlement).rejects.toBe(releaseError);
        } else {
          await settlement;
        }
        expect(getEventListeners(drainSignal, "abort")).toHaveLength(priorListeners);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        const fresh = await createAdmittedWizardSession(() => new WizardSession(async () => {}));
        expect(fresh).toBeDefined();
        await whenAdmittedWizardSessionSettled(fresh!);
      } finally {
        finish.resolve();
        if (session) {
          await whenAdmittedWizardSessionSettled(session).catch(() => {});
        }
        lock?.mockRestore();
      }
    },
  );

  it("releases an admitted session lease when construction fails", async () => {
    await expect(
      createAdmittedWizardSession(() => {
        throw new Error("construction failed");
      }),
    ).rejects.toThrow("construction failed");
    const recovered = await createAdmittedWizardSession(() => new WizardSession(async () => {}));
    expect(recovered).toBeDefined();
    await whenAdmittedWizardSessionSettled(recovered!);
  });

  it("reserves wizard admission while setup waits to acquire its target lock", async () => {
    const lockAcquired = createDeferred();
    const releaseLock = createDeferred();
    const lockOwner = setupMigration.withSetupMigrationTargetLock(mocks.stateDir, async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const setupAttempt = createAdmittedWizardSession(() => new WizardSession(async () => {}));
    const channelFactory = vi.fn(() => new WizardSession(async () => {}));
    await expect(createAdmittedWizardSession(channelFactory, false)).resolves.toBeUndefined();
    expect(channelFactory).not.toHaveBeenCalled();
    await expect(setupAttempt).resolves.toBeUndefined();

    releaseLock.resolve();
    await lockOwner;
  });

  it("rejects Gateway setup while the canonical onboarding target lock is held", async () => {
    const lockAcquired = createDeferred();
    const releaseLock = createDeferred();
    const lockOwner = setupMigration.withSetupMigrationTargetLock(mocks.stateDir, async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const task = vi.fn(async () => "unexpected");
    await expect(runExclusiveSystemAgentSetupActivation(task)).rejects.toThrow(
      "setup is already in progress",
    );
    expect(task).not.toHaveBeenCalled();

    releaseLock.resolve();
    await lockOwner;
    await expect(runExclusiveSystemAgentSetupActivation(async () => "ok")).resolves.toBe("ok");
  });
});
