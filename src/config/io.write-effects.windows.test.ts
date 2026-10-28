import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../../test/helpers/bounded-child-output.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import {
  buildEncodedPowerShellArgs,
  WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
} from "../infra/windows-powershell-spawn.js";
import {
  content,
  createWriteEffectsFixture,
  instrumentDestination,
  original,
  prepareClosedWrite,
  prepareWriteEffects as prepare,
} from "./io.write-effects.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const handshakeTimeout = WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS;
const testTimeout = 4 * handshakeTimeout;
const rollbackOptions = { durable: true, destinationHardlinks: "reject" as const };

// The child owns an actual Windows handle that permits reads/writes, but not rename/delete.
const holderScript = `
$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open($env:CONFIG_HOLDER_TARGET, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine([string]$PID)
  [Console]::Out.Flush()
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
  signal: AbortSignal,
  run: (io: typeof fs) => Promise<T>,
): Promise<T> {
  const control = dirs.make("config-windows-sharing-");
  const release = path.join(control, "release");
  const closed = path.join(control, "closed");
  const output = createBoundedChildOutput(4096);
  const child = spawn(getWindowsPowerShellExePath(), buildEncodedPowerShellArgs(holderScript), {
    env: {
      ...process.env,
      CONFIG_HOLDER_TARGET: target,
      CONFIG_HOLDER_RELEASE: release,
      CONFIG_HOLDER_CLOSED: closed,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const ready = createDeferred<number>();
  const lines = createInterface({ input: child.stdout });
  lines.once("line", (line) => ready.resolve(Number.parseInt(line, 10)));
  child.stderr.on("data", output.append);
  child.once("error", ready.reject);
  // Capture close before synchronous publication blocks JS callbacks.
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
    },
  );
  let nativeFailures = 0;
  try {
    const pid = await withinTest(
      Promise.race([
        ready.promise,
        completion.then(() => {
          throw new Error(`Sharing holder exited before readiness: ${output.text()}`);
        }),
      ]),
      signal,
    );
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
          expect(error, "Native error must reach the copy fallback").toMatchObject({
            code: expect.stringMatching(/^(EPERM|EEXIST)$/u),
          });
          nativeFailures++;
          fs.writeFileSync(release, "release");
          // Synchronous publish must wait for the persisted close, not a JS callback.
          const deadline = Date.now() + handshakeTimeout;
          const sleep = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(closed)) {
            if (Date.now() >= deadline) {
              throw new Error("Sharing holder did not close its native handle", { cause: error });
            }
            Atomics.wait(sleep, 0, 0, 10);
          }
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
      expect(await withinTest(completion, signal), output.text()).toEqual({
        code: 0,
        signal: null,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await completion;
      lines.close();
    }
  }
}

function fixture() {
  const root = fs.realpathSync(dirs.make("config-windows-effects-"));
  const dir = path.join(root, "owned");
  fs.mkdirSync(dir);
  return createWriteEffectsFixture(dir);
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
  return { ino: stat.ino, dev: stat.dev, raw: fs.readFileSync(target, "utf8") };
}
function expectRecoveryFiles(f: ReturnType<typeof fixture>) {
  expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
  expect(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

describe.runIf(process.platform === "win32")("native Windows config fallback effects", () => {
  it(
    "publishes and conditionally rolls back through real sharing failures",
    async ({ signal }) => {
      const f = fixture();
      const beforeAcl = acl(f.target);
      const rollbackProof = await withNativeSharingViolation(f.target, signal, async (io) => {
        const { prepared: stage, guarded } = await prepare(f, io);
        await using prepared = stage;
        expect(prepared.publish().method).toBe("copy-fallback");
        guarded.assertPublishedIdentity();
        return guarded.captureRollbackProof(f.assertCurrent);
      });
      expect(fs.readFileSync(f.target, "utf8")).toBe(content);
      expectRecoveryFiles(f);
      expect(acl(f.target)).toBe(beforeAcl);
      await withNativeSharingViolation(f.target, signal, async (io) => {
        await expect(
          f.rollback(io, rollbackProof, {
            ...rollbackOptions,
            preserveDirectoryMode: true,
          }),
        ).resolves.toBe(true);
      });
      expect(fs.readFileSync(f.target, "utf8")).toBe(original);
      expectRecoveryFiles(f);
      expect(acl(f.target)).toBe(beforeAcl);
    },
    testTimeout,
  );

  it.for([
    ["publication", "revoked"],
    ["rollback", "revoked"],
    ["rollback", "parent-directory"],
    ["rollback", "same-byte-file"],
  ] as const)(
    "%s rejects %s during native fallback",
    { timeout: testTimeout },
    async ([phase, fault], { signal }) => {
      const f = fixture();
      const initial = await prepareClosedWrite(f, phase === "rollback");
      const parentBefore = fs.lstatSync(f.dir, { bigint: true });
      const movedParent = `${f.dir}-owned`;
      let observed: ReturnType<typeof identity> | undefined;
      let writes = 0;
      await withNativeSharingViolation(f.target, signal, async (io) => {
        const instrumented = instrumentDestination(io, f.target, {
          closeOnOpenError: fault !== "revoked",
          chunkSize: 3,
          open() {
            if (fault === "parent-directory") {
              observed = identity(f.target);
              // Windows denies this move while the stage/destination is open.
              fs.renameSync(f.dir, movedParent);
            } else if (fault === "same-byte-file") {
              const raw = fs.readFileSync(f.target, "utf8");
              fs.renameSync(f.target, `${f.target}.owned`);
              fs.writeFileSync(f.target, raw);
              observed = identity(f.target);
            }
          },
          write() {
            writes++;
            if (fault === "revoked") {
              f.revoke();
              observed = identity(f.target);
            }
          },
        });
        if (phase === "publication") {
          await using prepared = (await prepare(f, instrumented)).prepared;
          expect(() => prepared.publish()).toThrow(f.refusal);
        } else {
          const rollback = expect(
            f.rollback(
              instrumented,
              initial.captureRollbackProof(f.assertCurrent),
              rollbackOptions,
            ),
          ).rejects;
          if (fault === "revoked") {
            await rollback.toBe(f.refusal);
          } else if (fault === "parent-directory") {
            await rollback.toMatchObject({ code: "EPERM" });
          } else {
            await rollback.toThrow(/changed/u);
          }
        }
      });
      expect(observed).toBeDefined();
      expect(writes).toBe(fault === "revoked" ? 1 : 0);
      expect(identity(f.target)).toEqual(observed);
      if (fault === "revoked") {
        expect(observed?.raw).toHaveLength(3);
      } else if (fault === "parent-directory") {
        expect(observed?.raw).toBe("");
        expect(fs.lstatSync(f.dir, { bigint: true })).toMatchObject({
          dev: parentBefore.dev,
          ino: parentBefore.ino,
        });
        expect(fs.existsSync(movedParent)).toBe(false);
      }
      expectRecoveryFiles(f);
    },
  );
});
