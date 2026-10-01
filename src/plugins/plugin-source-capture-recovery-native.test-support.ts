import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { withRuntimeWorkerGeneration } from "../infra/runtime-worker-generation.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import * as stagingOwner from "../infra/sqlite-snapshot-staging-owner.js";
import * as stagingToken from "../infra/sqlite-staging-token.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import type { RetainedNativeWorker } from "../infra/worker-native-lifecycle.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { startPluginSourceCaptureRoot } from "./plugin-source-capture-directory.js";
import { sweepPluginSourceCapturesForTest } from "./plugin-source-capture-directory.test-support.js";

export async function expectReclamationRetryAfterTargetLoss(stateDir: string): Promise<void> {
  const root = fs.realpathSync(stateDir);
  const abandoned = path.join(root, "tmp", "plugin-captures", "abandoned");
  const payload = path.join(abandoned, "captures", "source.js");
  const siblingDirectory = path.join(root, "live-sibling");
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.mkdirSync(siblingDirectory);
  fs.writeFileSync(payload, "original abandoned payload");
  stagingToken.acquireSqliteStagingToken(abandoned, "create")();
  const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  fs.utimesSync(abandoned, old, old);
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => {
        const scoped = new URL(url);
        scoped.searchParams.set("capture-retry-fixture", "target-loss");
        return scoped;
      });
      const source = captureRetainedNativeWorkerSource();
      const create = source.create.bind(source);
      const captureResource = source.captureResource.bind(source);
      const start = stagingOwner.startWorkerOwnedSqliteStagingToken;
      const admissions: Array<ReturnType<typeof start>> = [];
      const closes: Array<ReturnType<ReturnType<typeof start>["startClose"]>> = [];
      const restorePorts: Array<() => void> = [];
      const originalJoined = createDeferredCore();
      let originalTarget: RetainedNativeWorker | undefined;
      let heldDelivery: (() => void) | undefined;
      let stopped: Promise<void> | undefined;
      let gated = false;
      let executionExited = false;
      let targetJoined = false;
      const creations = vi.spyOn(source, "create").mockImplementation((...args) => {
        const target = create(...args);
        if (!originalTarget) {
          originalTarget = target;
          target.on("execution-exit", () => {
            executionExited = true;
            const deliver = heldDelivery;
            heldDelivery = undefined;
            deliver?.();
          });
          target.once("exit", () => {
            targetJoined = true;
            originalJoined.resolve();
          });
        }
        return target;
      });
      const connections = vi
        .spyOn(source, "captureResource")
        .mockImplementation((moduleUrl, key, input, connect) =>
          captureResource(
            moduleUrl,
            key,
            input,
            connect
              ? () => {
                  const connection = connect();
                  const post = connection.port.postMessage.bind(connection.port);
                  const forwarding = vi
                    .spyOn(connection.port, "postMessage")
                    .mockImplementation((...args) => {
                      const [message] = args;
                      if (
                        !gated &&
                        isRecord(message) &&
                        message.type === "token-reserved" &&
                        message.directory === abandoned
                      ) {
                        if (!originalTarget) {
                          throw new Error(
                            "Token reservation did not use the original staging target",
                          );
                        }
                        gated = true;
                        // Hold only this original delivery until the actual target VM has exited.
                        heldDelivery = () => post(...args);
                        stopped = originalTarget.stop().result;
                        void stopped.catch(() => undefined);
                        return;
                      }
                      post(...args);
                    });
                  restorePorts.push(() => forwarding.mockRestore());
                  return connection;
                }
              : undefined,
          ),
        );
      const observing = vi
        .spyOn(stagingOwner, "startWorkerOwnedSqliteStagingToken")
        .mockImplementation((...args) => {
          const admission = start(...args);
          if (args[0] === abandoned && args[1] === "reclaim") {
            admissions.push(admission);
            for (const method of ["startClose", "startRelease"] as const) {
              const close = admission[method].bind(admission);
              vi.spyOn(admission, method).mockImplementation(() => {
                const operation = close();
                closes.push(operation);
                return operation;
              });
            }
          }
          return admission;
        });
      const sibling = start(siblingDirectory, "create");
      let bodyFailure: { error: unknown } | undefined;
      const cleanupFailures: unknown[] = [];
      try {
        const token = await sibling.result;
        expect(token.isCurrent()).toBe(true);
        expect(creations.mock.calls.length).toBe(1);
        await sweepPluginSourceCapturesForTest(root);
        expect(gated).toBe(true);
        expect(executionExited).toBe(true);
        expect(targetJoined).toBe(false);
        expect(admissions.length).toBe(1);
        expect(admissions[0]?.read().status).toBe("rejected");
        expect(closes.length > 0).toBe(true);
        expect(closes.every((close) => close.read().status === "rejected")).toBe(true);
        const hasHeldTokenRefusal = (error: unknown): boolean =>
          error instanceof AggregateError
            ? error.errors.some((nested: unknown) => hasHeldTokenRefusal(nested))
            : error instanceof Error &&
              error.message === "SQLite staging token still has its plugin owner";
        expect(stopped !== undefined).toBe(true);
        if (!stopped) {
          throw new Error("Actual staging target stop was not observed");
        }
        expect(await stopped.then(() => false, hasHeldTokenRefusal)).toBe(true);
        expect(fs.readFileSync(payload, "utf8")).toBe("original abandoned payload");
        expect(fs.existsSync(path.join(siblingDirectory, "owner.sqlite"))).toBe(true);
        await token.close();
        await sibling.startRelease().result;
        await originalJoined.promise;
        expect(targetJoined).toBe(true);
        expect(captureRetainedNativeWorkerSource() === source).toBe(true);
        await sweepPluginSourceCapturesForTest(root);
        expect(fs.existsSync(abandoned)).toBe(false);
        expect(fs.existsSync(siblingDirectory)).toBe(true);
        expect(admissions.length).toBe(2);
        expect(admissions[1]?.read().status).toBe("fulfilled");
      } catch (error) {
        bodyFailure = { error };
      } finally {
        const deliver = heldDelivery;
        heldDelivery = undefined;
        try {
          deliver?.();
        } catch (error) {
          cleanupFailures.push(error);
        }
        const owned = [sibling, ...admissions];
        // Publish every original close intent before joining teardown.
        const outcomes = await Promise.allSettled(
          owned.map(async (admission) => await admission.startRelease().result),
        );
        const retries = await Promise.allSettled(
          outcomes.map(async (outcome, index) => {
            if (outcome.status !== "rejected") {
              return;
            }
            const admission = owned[index];
            if (!admission) {
              throw new Error("Original cleanup admission disappeared during teardown");
            }
            // A peer's completed join can now settle this same refused operation.
            await admission.startRelease().result;
          }),
        );
        for (const outcome of retries) {
          if (outcome.status === "rejected") {
            cleanupFailures.push(outcome.reason);
          }
        }
        for (const restore of [
          () => observing.mockRestore(),
          () => connections.mockRestore(),
          () => creations.mockRestore(),
          ...restorePorts,
        ]) {
          try {
            restore();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      throwSqliteLifecycleErrors(
        [...(bodyFailure ? [bodyFailure.error] : []), ...cleanupFailures],
        "Native reclamation control and cleanup failed",
      );
    },
    async () => {},
  );
}

export async function expectCaptureFinalRemovalRetry(
  stateDir: string,
  scenario:
    | "release"
    | "preparation"
    | "directory-replacement"
    | "token-replacement"
    | "root-absent",
): Promise<void> {
  const state = fs.realpathSync(stateDir);
  const managed = path.join(state, "tmp", "plugin-captures");
  const backup = path.join(state, "original-owner-backup.sqlite");
  const savedRoot = path.join(state, "original-root");
  const primary = Object.assign(new Error("Fixture capture preparation refused"), {
    code: "EACCES",
  });
  const removal = Object.assign(new Error("Fixture final root removal failed after token unlink"), {
    code: "EPERM",
  });
  const start = stagingOwner.startWorkerOwnedSqliteStagingToken;
  const remove = fsPromises.rm.bind(fsPromises);
  const mkdtemp = fsPromises.mkdtemp.bind(fsPromises);
  const closes: Array<ReturnType<ReturnType<typeof start>["startClose"]>> = [];
  let root: string | undefined;
  let originalAdmission: ReturnType<typeof start> | undefined;
  let originalDirectory: fs.BigIntStats | undefined;
  let originalToken: fs.BigIntStats | undefined;
  let replacementDirectory: fs.BigIntStats | undefined;
  let replacementTokenIdentity: fs.BigIntStats | undefined;
  let replacementToken: ReturnType<typeof stagingToken.acquireSqliteStagingToken> | undefined;
  let rootWasMoved = false;
  let injected = false;
  const acquiring = vi
    .spyOn(stagingOwner, "startWorkerOwnedSqliteStagingToken")
    .mockImplementation((...args) => {
      const admission = start(...args);
      if (!root && args[1] === "create" && path.dirname(args[0]) === managed) {
        root = args[0];
        originalAdmission = admission;
        const close = admission.startClose.bind(admission);
        vi.spyOn(admission, "startClose").mockImplementation(() => {
          const operation = close();
          closes.push(operation);
          return operation;
        });
      }
      return admission;
    });
  const preparing = vi.spyOn(fsPromises, "mkdtemp").mockImplementation(async (...args) => {
    if (
      scenario === "preparation" &&
      root &&
      typeof args[0] === "string" &&
      args[0].startsWith(path.join(root, "captures") + path.sep)
    ) {
      throw primary;
    }
    return await mkdtemp(...args);
  });
  const removing = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    if (target === root && root && !injected) {
      expect(options?.recursive).toBe(true);
      expect(closes.length > 0).toBe(true);
      expect(closes.every((close) => close.read().status === "fulfilled")).toBe(true);
      originalDirectory = fs.lstatSync(root, { bigint: true });
      const token = path.join(root, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]);
      originalToken = fs.lstatSync(token, { bigint: true });
      expect(originalToken.nlink === 1n).toBe(true);
      if (!originalAdmission) {
        throw new Error("Expected the actual original native admission");
      }
      expect(originalAdmission.read().status).toBe("fulfilled");
      const identity = originalAdmission.identity;
      expect(
        String(originalDirectory.dev) === identity.directory.dev &&
          String(originalDirectory.ino) === identity.directory.ino,
      ).toBe(true);
      expect(
        String(originalToken.dev) === identity.token.dev &&
          String(originalToken.ino) === identity.token.ino,
      ).toBe(true);
      // Faithful final-rm fault: retirement is real; only the final filesystem failure is injected.
      fs.linkSync(token, backup);
      fs.unlinkSync(token);
      injected = true;
      throw removal;
    }
    await remove(target, options);
  });
  const capture = startPluginSourceCaptureRoot(state, "final-removal-");
  let outcome: { error: unknown } | undefined;
  let preparationFailure: unknown;
  try {
    if (scenario === "preparation") {
      try {
        await capture.result;
        throw new Error("Expected actual capture preparation to fail");
      } catch (error) {
        preparationFailure = error;
      }
      expect(preparationFailure instanceof AggregateError).toBe(true);
      if (!(preparationFailure instanceof AggregateError)) {
        throw new Error("Expected original preparation and final-removal failures");
      }
      expect(preparationFailure.cause === primary).toBe(true);
      expect(preparationFailure.errors.length).toBe(2);
      expect(preparationFailure.errors[0] === primary).toBe(true);
      expect(preparationFailure.errors[1] === removal).toBe(true);
    } else {
      const captured = await capture.result;
      fs.writeFileSync(path.join(captured.directory, "source.js"), "owned source payload");
    }
    await expect(capture.release()).rejects.toBe(removal);
    expect(injected).toBe(true);
    if (!root || !originalDirectory || !originalToken) {
      throw new Error("Expected the original retired root and token identities");
    }
    const current = fs.lstatSync(root, { bigint: true });
    expect(current.dev === originalDirectory.dev && current.ino === originalDirectory.ino).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]))).toBe(false);
    const blocked = startPluginSourceCaptureRoot(state, "blocked-after-final-rm-");
    try {
      await expect(blocked.result).rejects.toThrow("Plugin source instance cleanup is incomplete");
    } finally {
      await blocked.release();
    }
    const sentinel = path.join(root, "replacement-source.txt");
    if (scenario === "root-absent") {
      // Keep the original inode only so the old-source control can restore its owner in teardown.
      fs.renameSync(root, savedRoot);
      rootWasMoved = true;
      expect(fs.lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
    } else if (scenario === "directory-replacement") {
      fs.renameSync(root, savedRoot);
      rootWasMoved = true;
      fs.mkdirSync(root);
      replacementDirectory = fs.lstatSync(root, { bigint: true });
      fs.writeFileSync(sentinel, "replacement directory bytes");
    } else if (scenario === "token-replacement") {
      fs.writeFileSync(sentinel, "replacement token bytes");
      replacementToken = stagingToken.acquireSqliteStagingToken(root, "create");
      replacementTokenIdentity = fs.lstatSync(
        path.join(root, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]),
        { bigint: true },
      );
      expect(
        replacementTokenIdentity.ino !== originalToken.ino ||
          replacementTokenIdentity.dev !== originalToken.dev,
      ).toBe(true);
    }
    if (scenario === "directory-replacement" || scenario === "token-replacement") {
      await expect(capture.release()).rejects.toThrow("identity changed before removal");
      expect(fs.readFileSync(sentinel, "utf8")).toBe(
        scenario === "directory-replacement"
          ? "replacement directory bytes"
          : "replacement token bytes",
      );
      if (replacementTokenIdentity) {
        const token = fs.lstatSync(path.join(root, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]), {
          bigint: true,
        });
        expect(
          token.dev === replacementTokenIdentity.dev && token.ino === replacementTokenIdentity.ino,
        ).toBe(true);
      }
    } else {
      const ownedRoots = [root, savedRoot];
      const countOwnedRemovals = () =>
        removing.mock.calls.filter(
          ([target]) =>
            typeof target === "string" &&
            ownedRoots.some(
              (directory) => target === directory || target.startsWith(directory + path.sep),
            ),
        ).length;
      const removalCalls = countOwnedRemovals();
      const parkedEntries = scenario === "root-absent" ? fs.readdirSync(savedRoot) : undefined;
      await capture.release();
      expect(fs.existsSync(root)).toBe(false);
      if (scenario === "root-absent") {
        expect(countOwnedRemovals()).toBe(removalCalls);
        const parked = fs.lstatSync(savedRoot, { bigint: true });
        expect(parked.dev === originalDirectory.dev && parked.ino === originalDirectory.ino).toBe(
          true,
        );
        expect(fs.readdirSync(savedRoot)).toEqual(parkedEntries);
        await remove(savedRoot, { recursive: true, force: true });
        rootWasMoved = false;
      }
      if (scenario === "preparation") {
        await expect(capture.result).rejects.toBe(preparationFailure);
      }
      const recovered = startPluginSourceCaptureRoot(state, "recovered-after-final-rm-");
      try {
        const value = await recovered.result;
        value.assertCurrent();
        expect(fs.existsSync(value.directory)).toBe(true);
      } finally {
        await recovered.release();
      }
    }
  } catch (error) {
    outcome = { error };
  }
  acquiring.mockRestore();
  preparing.mockRestore();
  removing.mockRestore();
  const cleanupErrors: unknown[] = [];
  const attempt = async (operation: () => void | Promise<void>) => {
    try {
      await operation();
      return true;
    } catch (error) {
      cleanupErrors.push(error);
      return false;
    }
  };
  await attempt(() => replacementToken?.());
  await attempt(async () => {
    if (!root) {
      return;
    }
    const token = path.join(root, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]);
    if (replacementTokenIdentity) {
      const current = fs.lstatSync(token, { bigint: true, throwIfNoEntry: false });
      if (current) {
        if (
          current.dev !== replacementTokenIdentity.dev ||
          current.ino !== replacementTokenIdentity.ino
        ) {
          throw new Error("Replacement token changed before fixture cleanup");
        }
        fs.unlinkSync(token);
      }
    }
    if (rootWasMoved) {
      const current = fs.lstatSync(root, { bigint: true, throwIfNoEntry: false });
      if (current) {
        if (
          !replacementDirectory ||
          current.dev !== replacementDirectory.dev ||
          current.ino !== replacementDirectory.ino
        ) {
          throw new Error("Replacement directory changed before fixture cleanup");
        }
        await remove(root, { recursive: true, force: true });
      }
      fs.renameSync(savedRoot, root);
    }
    const currentRoot = fs.lstatSync(root, { bigint: true, throwIfNoEntry: false });
    if (currentRoot && fs.existsSync(backup)) {
      if (
        !originalDirectory ||
        currentRoot.dev !== originalDirectory.dev ||
        currentRoot.ino !== originalDirectory.ino
      ) {
        throw new Error("Original root changed before restoring its fixture token");
      }
      const saved = fs.lstatSync(backup, { bigint: true });
      if (!originalToken || saved.dev !== originalToken.dev || saved.ino !== originalToken.ino) {
        throw new Error("Original token backup changed before fixture cleanup");
      }
      const currentToken = fs.lstatSync(token, { bigint: true, throwIfNoEntry: false });
      if (currentToken) {
        if (currentToken.dev !== originalToken.dev || currentToken.ino !== originalToken.ino) {
          throw new Error("Unexpected token before original fixture cleanup");
        }
      } else {
        fs.linkSync(backup, token);
      }
      fs.unlinkSync(backup);
    }
  });
  // The old-source control also joins the exact original capability after restoring its inode.
  if (!(await attempt(() => capture.release()))) {
    await attempt(() => capture.release());
  }
  await attempt(() => remove(backup, { force: true }));
  throwSqliteLifecycleErrors(
    [...(outcome ? [outcome.error] : []), ...cleanupErrors],
    "Final-removal fixture and original cleanup failed",
  );
}
