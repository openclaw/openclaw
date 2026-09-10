import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "../cli/update-cli/update-command-executor.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as temporaryRoot from "./tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("linked package slot admission", () => {
  it.each([false, true])(
    "reserves S before baseline while keeping canonical A (occupied=%s)",
    async (occupied) => {
      const home = fs.realpathSync(dirs.make("package-linked-custody-"));
      const fixture = await createPackageSwapFixture(home);
      const original = path.join(home, "original-checkout");
      fs.renameSync(fixture.packageRoot, original);
      fs.symlinkSync(original, fixture.packageRoot, "dir");
      vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(
        path.join(home, "authority"),
      );
      const store = createManagedHandoffLeaseStore();
      const winner = occupied
        ? store.acquire(fixture.packageRoot, randomUUID(), { kind: "update" })
        : undefined;
      const before = fs.readdirSync(fixture.globalRoot);
      const assertExcluded = () => {
        for (const root of [original, fixture.packageRoot]) {
          expect(store.acquire(root, randomUUID(), { kind: "update" }).kind).toBe("busy");
        }
      };
      const beforeActivate = vi.fn(() => {
        assertExcluded();
        return Promise.resolve();
      });
      let transaction: PackageUpdateTransaction | undefined;
      try {
        await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(original);
          const pending = swapStagedPackageInstall({
            ...fixture.params,
            activation: { fence, nodeRunner: process.execPath, onPrepared: () => undefined },
            beforeActivate,
            onTransaction(value) {
              transaction = value;
            },
          });
          if (occupied) {
            await expect(pending).rejects.toThrow("occupied slot");
            expect(beforeActivate).not.toHaveBeenCalled();
            expect(transaction).toBeUndefined();
            expect(fs.readdirSync(fixture.globalRoot)).toEqual(before);
            expect(fs.readlinkSync(fixture.packageRoot)).toBe(original);
            assert(winner?.kind === "acquired", "Independent slot owner exists");
            expect(store.current(winner.lease)).toBe(true);
          } else {
            const result = await pending;
            expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
            expect(beforeActivate).toHaveBeenCalledOnce();
            assertExcluded();
            expect(fs.lstatSync(fixture.packageRoot).isDirectory()).toBe(true);
            expect(
              JSON.parse(fs.readFileSync(path.join(original, "package.json"), "utf8")).version,
            ).toBe("1.0.0");
            assert(transaction, "Retained linked transaction exists");
            await expect(
              transaction.complete({ activationVerified: true }, fence.assertCurrent),
            ).resolves.toBeUndefined();
          }
          fence.assertCurrent();
        });
        expect(store.read(original).kind).toBe("absent");
        if (!occupied) {
          expect(store.read(fixture.packageRoot).kind).toBe("absent");
        }
      } finally {
        if (winner?.kind === "acquired") {
          expect(store.release(winner.lease)).toBe(true);
        }
      }
    },
  );
  it("runs the real package swap under delegated pre-reserved slot coverage", async () => {
    const home = fs.realpathSync(dirs.make("package-linked-delegated-"));
    const fixture = await createPackageSwapFixture(home);
    const original = path.join(home, "original-checkout");
    const foreign = path.join(home, "foreign");
    fs.renameSync(fixture.packageRoot, original);
    fs.mkdirSync(foreign);
    fs.symlinkSync(original, fixture.packageRoot, "dir");
    vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      path.join(home, "authority"),
    );
    const executorUrl = new URL("../cli/update-cli/update-command-executor.ts", import.meta.url)
      .href;
    const swapUrl = new URL("./package-update-swap.ts", import.meta.url).href;
    const storeUrl = new URL("./update-managed-service-handoff-lease.ts", import.meta.url).href;
    const program = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import {randomUUID} from 'node:crypto';
      import {withDelegatedUpdateCommandExecutor,reserveUpdateCommandExecutorSlot} from ${JSON.stringify(executorUrl)};
      import {swapStagedPackageInstall} from ${JSON.stringify(swapUrl)};
      import {createManagedHandoffLeaseStore} from ${JSON.stringify(storeUrl)};
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      const store=createManagedHandoffLeaseStore({databasePath:input.grant.databasePath,existingIdentity:input.grant.databaseIdentity,serviceManagerEnv:process.env});
      let retained;
      let prepared=false;
      await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.slot,async fence=>{
        retained=fence;
        let transaction;
        const result=await swapStagedPackageInstall({...input.params,
          activation:{fence,nodeRunner:process.execPath,onPrepared:()=>undefined},
          beforeActivate:async()=>{
            for(const root of [input.original,input.slot])assert.equal(store.acquire(root,randomUUID(),{kind:'update'}).kind,'busy');
            prepared=true;
          },
          onTransaction:value=>{transaction=value;}
        });
        assert.equal(result.status,'committed',result.step.stderrTail);
        assert.equal(prepared,true);
        assert.ok(transaction);
        await transaction.complete({activationVerified:true},fence.assertCurrent);
        assert.throws(()=>reserveUpdateCommandExecutorSlot(fence,input.foreign),/ungranted/);
        assert.equal(store.read(input.foreign).kind,'absent');
        fence.assertCurrent();
      });
      assert.throws(()=>reserveUpdateCommandExecutorSlot(retained,input.slot),/requires its live executor/);
      process.stdout.write('delegated-swap-complete');
    `;
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(fixture.packageRoot);
      const result = await withUpdateCommandExecutorChild(fence, (grant, beforeInput) =>
        runUtf8CommandWithTimeout(
          [
            process.execPath,
            "--import",
            path.resolve("scripts/tsx.mjs"),
            "--input-type=module",
            "-e",
            program,
          ],
          {
            input: JSON.stringify({
              grant,
              original,
              slot: fixture.packageRoot,
              foreign,
              params: fixture.params,
            }),
            beforeInput,
            timeoutMs: 20_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        ),
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("delegated-swap-complete");
      fence.assertCurrent();
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(fixture.packageRoot, "package.json"), "utf8")).version,
    ).toBe("2.0.0");
    const store = createManagedHandoffLeaseStore();
    expect(store.read(original).kind).toBe("absent");
    expect(store.read(fixture.packageRoot).kind).toBe("absent");
  }, 30_000);
});
