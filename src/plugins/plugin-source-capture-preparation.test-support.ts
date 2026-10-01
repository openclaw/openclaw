import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { withRuntimeWorkerGeneration } from "../infra/runtime-worker-generation.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { startPluginSourceCaptureRoot } from "./plugin-source-capture-directory.js";

export async function runUnadmittedCaptureCleanupRetry(
  stateDir: string,
  scenario: string | undefined,
): Promise<void> {
  assert(
    scenario === "retry" ||
      scenario === "realpath-refusal" ||
      scenario === "directory-replacement" ||
      scenario === "token-replacement" ||
      scenario === "sidecar-replacement",
  );
  let generationReleased = false;
  await withRuntimeWorkerGeneration(
    async (bind) => {
      const bindUrl = (url: URL) => {
        const scoped = new URL(url);
        scoped.searchParams.set("capture-creator-fixture", "unadmitted");
        return scoped;
      };
      bind(bindUrl);
      const source = captureRetainedNativeWorkerSource();
      const create = source.create.bind(source);
      const stagingUrl = bindUrl(resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging")).href;
      let dispatches = 0;
      const creating = mock.method(
        source,
        "create",
        (...args: Parameters<typeof source.create>) => {
          if (String(args[0]) === stagingUrl) {
            dispatches++;
          }
          return create(...args);
        },
      );
      const state = fs.realpathSync(stateDir);
      const managed = path.join(state, "tmp", "plugin-captures");
      const parked = path.join(state, "original-creator-root");
      const open = fs.openSync.bind(fs);
      const remove = fsPromises.rm.bind(fsPromises);
      const realpath = fsPromises.realpath.bind(fsPromises);
      let root: string | undefined;
      let originalDirectory: fs.BigIntStats | undefined;
      let primary: unknown;
      let refusedOpen = false;
      let refusedRealpath = false;
      let refusedCleanup = false;
      const cleanup = Object.assign(new Error("Fixture creator cleanup refused"), {
        code: "EPERM",
      });
      const resolutionFailure = Object.assign(new Error("Fixture creator realpath refused"), {
        code: "EACCES",
      });
      const stating =
        scenario === "realpath-refusal" ? mock.method(fsPromises, "lstat") : undefined;
      const resolving =
        scenario === "realpath-refusal"
          ? mock.method(
              fsPromises,
              "realpath",
              async (...args: Parameters<typeof fsPromises.realpath>) => {
                const [file] = args;
                if (
                  !refusedRealpath &&
                  typeof file === "string" &&
                  path.dirname(file) === managed
                ) {
                  assert(stating);
                  const prior = stating.mock.calls.find(
                    (call) => call.arguments[0] === file && call.arguments[1]?.bigint === true,
                  );
                  assert(prior?.result);
                  const observed = await prior.result;
                  assert(observed.isDirectory());
                  root = file;
                  originalDirectory = fs.lstatSync(file, { bigint: true });
                  assert.equal(String(observed.dev), String(originalDirectory.dev));
                  assert.equal(String(observed.ino), String(originalDirectory.ino));
                  // Only realpath is injected after the real creator lstat has fulfilled.
                  refusedRealpath = true;
                  primary = resolutionFailure;
                  throw resolutionFailure;
                }
                return await realpath(...args);
              },
            )
          : undefined;
      const opening = mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const [file, flags, mode] = args;
        if (
          scenario !== "realpath-refusal" &&
          !refusedOpen &&
          flags === "wx" &&
          typeof file === "string" &&
          path.basename(file) === "owner.sqlite" &&
          path.dirname(path.dirname(file)) === managed
        ) {
          refusedOpen = true;
          root = path.dirname(file);
          originalDirectory = fs.lstatSync(root, { bigint: true });
          fs.writeFileSync(file, "exclusive-create fixture blocker");
          const blocker = fs.lstatSync(file, { bigint: true });
          try {
            return open(file, flags, mode);
          } catch (error) {
            primary = error;
            throw error;
          } finally {
            const current = fs.lstatSync(file, { bigint: true });
            assert.equal(current.dev, blocker.dev);
            assert.equal(current.ino, blocker.ino);
            fs.unlinkSync(file);
          }
        }
        return open(file, flags, mode);
      });
      const removing = mock.method(
        fsPromises,
        "rm",
        async (...args: Parameters<typeof fsPromises.rm>) => {
          const [target, options] = args;
          if (root && target === path.join(root, "captures") && !refusedCleanup) {
            refusedCleanup = true;
            throw cleanup;
          }
          await remove(target, options);
        },
      );
      let capture: ReturnType<typeof startPluginSourceCaptureRoot> | undefined;
      let recovered: ReturnType<typeof startPluginSourceCaptureRoot> | undefined;
      let bodyFailure: { error: unknown } | undefined;
      const failures: unknown[] = [];
      const restorations: Array<() => Promise<void>> = [];
      let phase = "preparation";
      try {
        capture = startPluginSourceCaptureRoot(state, "unadmitted-creator-");
        const failure: unknown = await capture.result.then(
          () => {
            throw new Error("Expected creator preparation refusal");
          },
          (error: unknown) => error,
        );
        assert(primary instanceof Error);
        if (scenario === "realpath-refusal") {
          assert.equal(primary, resolutionFailure);
          assert(refusedRealpath);
          assert.equal(refusedOpen, false);
        } else {
          assert.equal(Reflect.get(primary, "code"), "EEXIST");
          assert(refusedOpen);
        }
        assert(failure instanceof AggregateError);
        assert.equal(failure.cause, primary);
        assert.equal(failure.errors.length, 2);
        assert.equal(failure.errors[0], primary);
        assert.equal(failure.errors[1], cleanup);
        assert(refusedCleanup);
        assert.equal(dispatches, 0);
        assert(root && originalDirectory);
        const originalRoot = root;
        const originalIdentity = originalDirectory;
        assert.equal(fs.existsSync(path.join(originalRoot, "owner.sqlite")), false);
        await assert.rejects(capture.release(), (error: unknown) => error === cleanup);
        const blocked = startPluginSourceCaptureRoot(state, "blocked-unadmitted-");
        try {
          await assert.rejects(blocked.result, /cleanup is incomplete/);
        } finally {
          await blocked.release();
        }
        opening.mock.restore();
        removing.mock.restore();
        resolving?.mock.restore();
        stating?.mock.restore();
        if (scenario !== "retry" && scenario !== "realpath-refusal") {
          let restore: () => Promise<void>;
          let sentinel: string;
          if (scenario === "directory-replacement") {
            fs.renameSync(originalRoot, parked);
            fs.mkdirSync(originalRoot);
            const replacement = fs.lstatSync(originalRoot, { bigint: true });
            sentinel = path.join(originalRoot, "foreign-source.txt");
            fs.writeFileSync(sentinel, "preserve foreign bytes");
            restore = async () => {
              const current = fs.lstatSync(originalRoot, { bigint: true });
              assert.equal(current.dev, replacement.dev);
              assert.equal(current.ino, replacement.ino);
              await remove(originalRoot, { recursive: true, force: true });
              const saved = fs.lstatSync(parked, { bigint: true });
              assert.equal(saved.dev, originalIdentity.dev);
              assert.equal(saved.ino, originalIdentity.ino);
              fs.renameSync(parked, originalRoot);
            };
          } else {
            sentinel = path.join(
              originalRoot,
              scenario === "token-replacement" ? "owner.sqlite" : "owner.sqlite-wal",
            );
            fs.writeFileSync(sentinel, "preserve foreign bytes");
            const replacement = fs.lstatSync(sentinel, { bigint: true });
            restore = async () => {
              const current = fs.lstatSync(sentinel, { bigint: true });
              assert.equal(current.dev, replacement.dev);
              assert.equal(current.ino, replacement.ino);
              fs.unlinkSync(sentinel);
            };
          }
          restorations.push(restore);
          phase = "replacement-refusal";
          await assert.rejects(
            capture.release(),
            scenario === "directory-replacement"
              ? /original directory identity/
              : /unowned token files/,
          );
          assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve foreign bytes");
          await restore();
          restorations.pop();
        }
        phase = "original-creator-retry";
        await capture.release();
        assert.equal(fs.existsSync(originalRoot), false);
        assert.equal(dispatches, 0);
        await assert.rejects(capture.result, (error: unknown) => error === failure);
        phase = "fresh-admission";
        recovered = startPluginSourceCaptureRoot(state, "recovered-unadmitted-");
        const value = await recovered.result;
        value.assertCurrent();
        assert(fs.existsSync(value.directory));
        assert(dispatches > 0);
      } catch (error) {
        bodyFailure = { error };
      } finally {
        opening.mock.restore();
        removing.mock.restore();
        resolving?.mock.restore();
        stating?.mock.restore();
        for (const restore of restorations.toReversed()) {
          try {
            await restore();
          } catch (error) {
            failures.push(error);
          }
        }
        const admissions = [capture, recovered].filter((admission) => admission !== undefined);
        const outcomes = await Promise.allSettled(
          admissions.map(async (admission) => await admission.release()),
        );
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            failures.push(outcome.reason);
          }
        }
        creating.mock.restore();
      }
      throwSqliteLifecycleErrors(
        [...(bodyFailure ? [bodyFailure.error] : []), ...failures],
        "Creator cleanup fixture failed at " + phase,
      );
    },
    async () => {
      generationReleased = true;
    },
  );
  assert.equal(generationReleased, true);
  process.stdout.write("original creator cleanup recovered");
}
