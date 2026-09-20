import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as pidAlive from "../../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../../test-utils/process-tree.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-executor-descendants-"));
  const temporary = path.join(root, "private-tmp");
  fs.mkdirSync(temporary, { mode: 0o700 });
  // Only the database location is isolated; lease ownership and process probes stay real.
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
});
afterEach(() => vi.restoreAllMocks());

describe("candidate executor delegation", () => {
  it.skipIf(process.platform === "win32").each([false, true])(
    "does not release either installation while a candidate descendant is alive (changed root=%s)",
    async (changedRoot) => {
      const candidateRoot = changedRoot ? path.join(root, "activated") : root;
      if (changedRoot) {
        fs.mkdirSync(candidateRoot);
      }
      let descendant: number | undefined;
      let candidatePid: number | undefined;
      const expectedReleases = new Set([root, candidateRoot]);
      const released = new Set<string>();
      const leaseOwner = await import("../../infra/update-managed-service-handoff-lease.js");
      const createStore = leaseOwner.createManagedHandoffLeaseStore;
      vi.spyOn(leaseOwner, "createManagedHandoffLeaseStore").mockImplementation((...args) => {
        const store = createStore(...args);
        return {
          ...store,
          release(lease) {
            if (expectedReleases.has(lease.key)) {
              assert(descendant !== undefined && candidatePid !== undefined);
              expect(pidAlive.isPidDefinitelyDead(descendant)).toBe(true);
              expect(isChildProcessTreeAlive({ pid: candidatePid })).toBe(false);
              expect(store.current(lease)).toBe(true);
            }
            const confirmed = store.release(lease);
            if (confirmed && expectedReleases.has(lease.key)) {
              released.add(lease.key);
            }
            return confirmed;
          },
        };
      });
      const store = createStore();
      try {
        await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(root);
          await withUpdateCommandExecutorChild(fence, candidateRoot, async (grant, beforeInput) => {
            expectedReleases.add(grant.childKey);
            if (grant.originalChildKey) {
              expectedReleases.add(grant.originalChildKey);
            }
            const result = await runUtf8CommandWithTimeout(
              [
                process.execPath,
                "-e",
                `const fs=require('node:fs');const {spawn}=require('node:child_process');
                  JSON.parse(fs.readFileSync(0,'utf8'));
                  const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});
                  child.once('message',()=>{process.stdout.write(String(child.pid));child.disconnect();child.unref();});`,
              ],
              {
                input: JSON.stringify(grant),
                beforeInput,
                killProcessTree: true,
                timeoutMs: 15_000,
              },
            );
            descendant = Number(result.stdout);
            candidatePid = result.pid;
            expect(result.code, result.stderr).toBe(0);
            expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
            assert(candidatePid !== undefined);
            expect(pidAlive.isPidAlive(descendant)).toBe(true);
            expect(isChildProcessTreeAlive({ pid: candidatePid })).toBe(true);
            for (const installation of new Set([root, candidateRoot])) {
              expect(store.read(installation).kind).toBe("current");
              expect(store.acquire(installation, "next-owner", { kind: "update" }).kind).toBe(
                "busy",
              );
            }
            expect(released.size).toBe(0);
            return result;
          });
        });
        expect(released).toEqual(expectedReleases);
        for (const key of expectedReleases) {
          expect(store.read(key)).toEqual({ kind: "absent" });
        }
      } finally {
        if (descendant) {
          killPidIfAlive(descendant);
          expect(await waitForPidToExit(descendant)).toBe(true);
        }
      }
    },
  );
});
