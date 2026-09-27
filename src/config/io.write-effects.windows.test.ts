import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../../test/helpers/bounded-child-output.js";
import { waitForChildClose, waitForPidFile } from "../../test/helpers/process-wait.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import {
  buildEncodedPowerShellArgs,
  WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
} from "../infra/windows-powershell-spawn.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import {
  captureConfigFileWritePathProof,
  createGuardedConfigFileSystem,
  rollbackConfigFileWriteIfUnchanged,
} from "./io.write-safety.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const original = '{"channel":"stable"}\n';
const content = '{"channel":"beta"}\n';
const handshakeTimeout = WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS;
const testTimeout = 4 * handshakeTimeout;

// The child owns an actual Windows handle that permits reads/writes, but not rename/delete.
const holderScript = `
$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open($env:CONFIG_HOLDER_TARGET, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [IO.File]::WriteAllText($env:CONFIG_HOLDER_READY, [string]$PID)
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (-not [IO.File]::Exists($env:CONFIG_HOLDER_RELEASE)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Sharing holder was not released' }
    Start-Sleep -Milliseconds 10
  }
} finally {
  $handle.Dispose()
  [IO.File]::WriteAllText($env:CONFIG_HOLDER_CLOSED, [string]$PID)
}`;

async function withNativeSharingViolation<T>(
  target: string,
  run: (io: typeof fs) => Promise<T>,
): Promise<T> {
  const control = dirs.make("config-windows-sharing-");
  const ready = path.join(control, "ready");
  const release = path.join(control, "release");
  const closed = path.join(control, "closed");
  const output = createBoundedChildOutput(4096);
  const child = spawn(getWindowsPowerShellExePath(), buildEncodedPowerShellArgs(holderScript), {
    env: {
      ...process.env,
      CONFIG_HOLDER_TARGET: target,
      CONFIG_HOLDER_READY: ready,
      CONFIG_HOLDER_RELEASE: release,
      CONFIG_HOLDER_CLOSED: closed,
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", output.append);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const completion = waitForChildClose(child, 2 * handshakeTimeout);
  // Attach immediately; the synchronous filesystem call below temporarily owns this thread.
  void completion.catch(() => undefined);
  let nativeFailures = 0;
  try {
    const pid = await Promise.race([
      waitForPidFile(ready, handshakeTimeout),
      completion.then(() => {
        throw spawnError ?? new Error(`Sharing holder exited before readiness: ${output.text()}`);
      }),
    ]);
    expect(pid).toBe(child.pid);
    const result = await run({
      ...fs,
      renameSync(from, to) {
        if (String(to) !== target) {
          return fs.renameSync(from, to);
        }
        try {
          fs.renameSync(from, to);
        } catch (error) {
          expect(
            error,
            "Native rename must produce EPERM or EEXIST to exercise fs-safe's copy fallback; unsupported kernel errors must not be remapped",
          ).toMatchObject({ code: expect.stringMatching(/^(EPERM|EEXIST)$/u) });
          nativeFailures++;
          fs.writeFileSync(release, "release");
          // publish() is synchronous: wait for the child's persisted handle-close fact,
          // not a JS callback or a guessed delay, before the real fallback continues.
          const deadline = Date.now() + handshakeTimeout;
          const sleep = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(closed)) {
            if (Date.now() >= deadline) {
              throw new Error("Sharing holder did not close its native handle", { cause: error });
            }
            Atomics.wait(sleep, 0, 0, 10);
          }
          // This is the actual kernel error from the attempted product rename.
          throw error;
        }
        throw new Error("The native sharing holder did not prevent rename");
      },
    });
    expect(nativeFailures).toBe(1);
    return result;
  } finally {
    fs.writeFileSync(release, "release");
    try {
      expect(await completion, output.text()).toEqual({ code: 0, signal: null });
    } finally {
      await stopChildProcess(child, 1000, { force: true });
    }
  }
}

function fixture() {
  const root = fs.realpathSync(dirs.make("config-windows-effects-"));
  const dir = path.join(root, "owned");
  fs.mkdirSync(dir);
  const target = path.join(dir, "channel.json");
  fs.writeFileSync(target, original);
  const proof = captureConfigFileWritePathProof(target, target, fs);
  const refusal = new Error("original updater revoked");
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw refusal;
    }
    proof.assertCurrent();
  };
  const options = {
    snapshot: { path: target, exists: true, raw: original },
    includeGraph: { hashes: {}, targets: {} },
    targetPathProof: proof,
    preserveDirectoryMode: true,
  };
  return { root, dir, target, options, assertCurrent, refusal, revoke: () => (current = false) };
}

async function prepare(f: ReturnType<typeof fixture>, io: typeof fs = fs) {
  const guarded = createGuardedConfigFileSystem(f.target, io, f.assertCurrent, f.options);
  const prepared = await prepareConfigFileWrite({
    configPath: f.target,
    previousRaw: original,
    content,
    fsModule: guarded.fileSystem,
    assertCurrent: guarded.assertCurrent,
    destinationHardlinks: "reject",
    durable: true,
  });
  return { guarded, prepared };
}

function acl(target: string): string {
  return execFileSync(
    getWindowsPowerShellExePath(),
    buildEncodedPowerShellArgs(
      "Get-Acl -LiteralPath $env:CONFIG_ACL_TARGET | Select-Object Owner,Sddl | ConvertTo-Json -Compress",
    ),
    {
      env: { ...process.env, CONFIG_ACL_TARGET: target },
      encoding: "utf8",
      timeout: handshakeTimeout,
    },
  ).trim();
}

function identity(target: string) {
  const stat = fs.lstatSync(target, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, raw: fs.readFileSync(target, "utf8") };
}

describe.runIf(process.platform === "win32")("native Windows config fallback effects", () => {
  it(
    "publishes and conditionally rolls back through real sharing failures",
    async () => {
      const f = fixture();
      const beforeAcl = acl(f.target);
      const rollbackProof = await withNativeSharingViolation(f.target, async (io) => {
        const { prepared, guarded } = await prepare(f, io);
        try {
          expect(prepared.publish().method).toBe("copy-fallback");
          guarded.assertPublishedIdentity();
          return guarded.captureRollbackProof(f.assertCurrent);
        } finally {
          await prepared[Symbol.asyncDispose]();
        }
      });
      expect(fs.readFileSync(f.target, "utf8")).toBe(content);
      expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
      expect(acl(f.target)).toBe(beforeAcl);
      await withNativeSharingViolation(f.target, async (io) => {
        await expect(
          rollbackConfigFileWriteIfUnchanged({
            configPath: f.target,
            previousSnapshot: f.options.snapshot,
            committedHash: hashConfigRaw(content),
            fsModule: io,
            ...rollbackProof,
            preserveDirectoryMode: true,
            durable: true,
            destinationHardlinks: "reject",
          }),
        ).resolves.toBe(true);
      });
      expect(fs.readFileSync(f.target, "utf8")).toBe(original);
      expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
      expect(acl(f.target)).toBe(beforeAcl);
      expect(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    testTimeout,
  );

  it.each(["publication", "rollback"] as const)(
    "stops %s after authority is revoked during a native fallback partial write",
    async (phase) => {
      const f = fixture();
      const initial = await prepare(f);
      try {
        if (phase === "rollback") {
          initial.prepared.publish();
        }
      } finally {
        await initial.prepared[Symbol.asyncDispose]();
      }
      let observed: ReturnType<typeof identity> | undefined;
      let writes = 0;
      await withNativeSharingViolation(f.target, async (io) => {
        let destinationFd: number | undefined;
        const instrumented: typeof fs = {
          ...io,
          openSync(name, flags, mode) {
            const fd = fs.openSync(name, flags, mode);
            if (
              String(name) === f.target &&
              typeof flags === "number" &&
              flags & fs.constants.O_EXCL
            ) {
              destinationFd = fd;
            }
            return fd;
          },
          writeSync: new Proxy(fs.writeSync, {
            apply(fn, self, args) {
              if (args[0] === destinationFd) {
                args[3] = Math.min(args[3], 3);
              }
              const count = Reflect.apply(fn, self, args);
              if (args[0] === destinationFd) {
                writes++;
                f.revoke();
                observed = identity(f.target);
              }
              return count;
            },
          }),
        };
        if (phase === "publication") {
          const { prepared } = await prepare(f, instrumented);
          try {
            expect(() => prepared.publish()).toThrow(f.refusal);
          } finally {
            await prepared[Symbol.asyncDispose]();
          }
        } else {
          await expect(
            rollbackConfigFileWriteIfUnchanged({
              configPath: f.target,
              previousSnapshot: f.options.snapshot,
              committedHash: hashConfigRaw(content),
              fsModule: instrumented,
              ...initial.guarded.captureRollbackProof(f.assertCurrent),
              durable: true,
              destinationHardlinks: "reject",
            }),
          ).rejects.toBe(f.refusal);
        }
      });
      expect(writes).toBe(1);
      expect(observed?.raw).toHaveLength(3);
      expect(identity(f.target)).toEqual(observed);
      expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
      expect(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    testTimeout,
  );

  it(
    "preserves the open rollback destination when Windows denies a parent-directory move",
    async () => {
      const f = fixture();
      const { prepared, guarded } = await prepare(f);
      try {
        prepared.publish();
      } finally {
        await prepared[Symbol.asyncDispose]();
      }
      const rollbackProof = guarded.captureRollbackProof(f.assertCurrent);
      const parentBefore = fs.lstatSync(f.dir, { bigint: true });
      const movedParent = `${f.dir}-owned`;
      let observed: ReturnType<typeof identity> | undefined;
      let destinationWrites = 0;
      await withNativeSharingViolation(f.target, async (io) => {
        let destinationFd: number | undefined;
        const instrumented: typeof fs = {
          ...io,
          openSync(name, flags, mode) {
            const fd = fs.openSync(name, flags, mode);
            try {
              if (
                String(name) === f.target &&
                typeof flags === "number" &&
                flags & fs.constants.O_EXCL
              ) {
                destinationFd = fd;
                observed = identity(f.target);
                // Windows denies this move while the atomic stage/destination is open.
                // The cross-platform effect matrix separately proves the parent guard.
                fs.renameSync(f.dir, movedParent);
              }
              return fd;
            } catch (error) {
              // The production adapter cannot adopt the descriptor until this call returns.
              try {
                fs.closeSync(fd);
              } catch (closeError) {
                throw new AggregateError(
                  [error, closeError],
                  "Native parent-move injection and descriptor close failed",
                  { cause: closeError },
                );
              }
              throw error;
            }
          },
          writeSync: new Proxy(fs.writeSync, {
            apply(fn, self, args) {
              if (args[0] === destinationFd) {
                destinationWrites++;
              }
              return Reflect.apply(fn, self, args);
            },
          }),
        };
        await expect(
          rollbackConfigFileWriteIfUnchanged({
            configPath: f.target,
            previousSnapshot: f.options.snapshot,
            committedHash: hashConfigRaw(content),
            fsModule: instrumented,
            ...rollbackProof,
            durable: true,
            destinationHardlinks: "reject",
          }),
        ).rejects.toMatchObject({
          code: "EPERM",
          syscall: "rename",
          path: f.dir,
          dest: movedParent,
        });
      });
      expect(observed).toBeDefined();
      expect(observed?.raw).toBe("");
      expect(destinationWrites).toBe(0);
      expect(identity(f.target)).toEqual(observed);
      expect(fs.lstatSync(f.dir, { bigint: true })).toMatchObject({
        dev: parentBefore.dev,
        ino: parentBefore.ino,
      });
      expect(fs.existsSync(movedParent)).toBe(false);
      expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
      expect(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    testTimeout,
  );

  it(
    "does not write a same-byte-file replacement after opening its native rollback destination",
    async () => {
      const f = fixture();
      const { prepared, guarded } = await prepare(f);
      try {
        prepared.publish();
      } finally {
        await prepared[Symbol.asyncDispose]();
      }
      const rollbackProof = guarded.captureRollbackProof(f.assertCurrent);
      let observed: ReturnType<typeof identity> | undefined;
      let replacementWrites = 0;
      await withNativeSharingViolation(f.target, async (io) => {
        let destinationFd: number | undefined;
        const instrumented: typeof fs = {
          ...io,
          openSync(name, flags, mode) {
            const fd = fs.openSync(name, flags, mode);
            try {
              if (
                String(name) === f.target &&
                typeof flags === "number" &&
                flags & fs.constants.O_EXCL
              ) {
                destinationFd = fd;
                const raw = fs.readFileSync(f.target, "utf8");
                fs.renameSync(f.target, `${f.target}.owned`);
                fs.writeFileSync(f.target, raw);
                observed = identity(f.target);
              }
              return fd;
            } catch (error) {
              // The production adapter cannot adopt the descriptor until this call returns.
              try {
                fs.closeSync(fd);
              } catch (closeError) {
                throw new AggregateError(
                  [error, closeError],
                  "Native replacement injection and descriptor close failed",
                  { cause: closeError },
                );
              }
              throw error;
            }
          },
          writeSync: new Proxy(fs.writeSync, {
            apply(fn, self, args) {
              if (args[0] === destinationFd) {
                replacementWrites++;
              }
              return Reflect.apply(fn, self, args);
            },
          }),
        };
        await expect(
          rollbackConfigFileWriteIfUnchanged({
            configPath: f.target,
            previousSnapshot: f.options.snapshot,
            committedHash: hashConfigRaw(content),
            fsModule: instrumented,
            ...rollbackProof,
            durable: true,
            destinationHardlinks: "reject",
          }),
        ).rejects.toThrow(/changed/u);
      });
      expect(observed).toBeDefined();
      expect(replacementWrites).toBe(0);
      expect(identity(f.target)).toEqual(observed);
      expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
      expect(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    testTimeout,
  );
});
