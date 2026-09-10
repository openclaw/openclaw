import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { waitForPidToExit } from "../../test-utils/process-tree.js";
import {
  captureUpdateCommandExecutorAuthority,
  reserveUpdateCommandExecutorSlot,
  type UpdateCommandChildGrant,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let home: string;
let original: string;
let slot: string;
let temporary: string;
beforeEach(() => {
  home = fs.realpathSync(dirs.make("linked-root-custody-"));
  original = path.join(home, "operator-checkout");
  slot = path.join(home, "package-slot");
  temporary = path.join(home, "authority");
  fs.mkdirSync(original);
  fs.mkdirSync(temporary);
  fs.symlinkSync(original, slot, "dir");
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
});
afterEach(() => vi.restoreAllMocks());
const moduleUrl = new URL("./update-command-executor.ts", import.meta.url).href;
const execUrl = new URL("../../process/exec.ts", import.meta.url).href;
const loader = path.resolve("scripts/tsx.mjs");
const program = `
  import fs from 'node:fs';
  import {setTimeout} from 'node:timers/promises';
  import {withDelegatedUpdateCommandExecutor,withUpdateCommandExecutorChild} from ${JSON.stringify(moduleUrl)};
  import {runUtf8CommandWithTimeout} from ${JSON.stringify(execUrl)};
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.root,async fence=>{
    if(input.nested){
      await withUpdateCommandExecutorChild(fence,async (grant,beforeInput)=>{
        const pending=runUtf8CommandWithTimeout(input.argv,{
          input:JSON.stringify({...input,grant,nested:false}),beforeInput,
          timeoutMs:15000,killProcessTree:true,requireProcessTreeExtinction:true,
          onOutputChunk:chunk=>process.stdout.write(chunk)
        });
        try{fence.assertCurrent();throw new Error('parent was not suspended');}
        catch(error){if(!error.message.includes('suspended'))throw error;}
        const result=await pending;
        if(result.code!==0)throw new Error(result.stderr);
      });
    }else{
      fs.writeFileSync(input.info,JSON.stringify({grant:input.grant,pid:process.pid}));
      process.stdout.write('admitted\\n');
      while(!fs.existsSync(input.proceed))await setTimeout(10);
      fence.assertCurrent();
      fs.writeFileSync(input.output,'owned');
    }
    fence.assertCurrent();
  });
`;
const command = [process.execPath, "--import", loader, "--input-type=module", "-e", program];
function publishSlot() {
  fs.unlinkSync(slot);
  fs.mkdirSync(slot);
}
function assertExcluded() {
  const store = createManagedHandoffLeaseStore();
  expect(store.acquire(original, randomUUID(), { kind: "update" }).kind).toBe("busy");
  expect(store.acquire(slot, randomUUID(), { kind: "update" }).kind).toBe("busy");
}
function revoke(key: string, samePid = false) {
  const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
  try {
    if (samePid) {
      db.prepare(
        "UPDATE managed_update_handoffs SET payload_json = json_set(payload_json, '$.executor.startIdentity', 'revoked-start') WHERE install_root = ?",
      ).run(key);
    } else {
      db.prepare(
        "UPDATE managed_update_handoffs SET updated_at = updated_at + 1 WHERE install_root = ?",
      ).run(key);
    }
  } finally {
    db.close();
  }
}

describe.skipIf(process.platform === "win32")("linked installation custody", () => {
  it.each(["healthy", "original-revoked", "slot-revoked", "spawner-revoked", "same-pid-rebound"])(
    "retains both roots through nested child settlement (%s)",
    async (mode) => {
      const proceed = path.join(home, "proceed");
      const info = path.join(home, "child.json");
      const output = path.join(home, "effect");
      const ready = createDeferred();
      const operation = withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(slot);
        assertExcluded();
        publishSlot();
        assertExcluded();
        expect(await executor.enter(slot)).toBe(fence);
        const pending = withUpdateCommandExecutorChild(fence, (grant, bindChild) => {
          expect(grant.parent.key).toBe(original);
          expect(grant.slot?.parent.key).toBe(slot);
          return runUtf8CommandWithTimeout(command, {
            input: JSON.stringify({
              grant,
              root: slot,
              nested: true,
              argv: command,
              info,
              proceed,
              output,
            }),
            beforeInput(pid) {
              bindChild(pid);
              expect(() => bindChild(pid)).toThrow("only once");
            },
            timeoutMs: 20_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            onOutputChunk: (chunk) => {
              if (chunk.toString().includes("admitted")) {
                ready.resolve();
              }
            },
          });
        });
        try {
          await Promise.race([
            ready.promise,
            pending.then((result) => {
              throw new Error(result.stderr);
            }),
          ]);
          assertExcluded();
          const observed = JSON.parse(fs.readFileSync(info, "utf8")) as {
            grant: UpdateCommandChildGrant;
          };
          expect(observed.grant.parent.key).toBe(original);
          expect(observed.grant.spawner?.key).not.toBe(original);
          const store = createManagedHandoffLeaseStore();
          assert(
            observed.grant.spawner && observed.grant.slot,
            "Nested paired spawners are required",
          );
          expect(store.releaseAll([observed.grant.spawner, observed.grant.slot.spawner])).toBe(
            false,
          );
          if (mode === "original-revoked") {
            revoke(original);
          }
          if (mode === "slot-revoked") {
            revoke(slot);
          }
          if (mode === "spawner-revoked") {
            revoke(observed.grant.spawner.key);
          }
          if (mode === "same-pid-rebound") {
            revoke(observed.grant.spawner.key, true);
          }
        } finally {
          fs.writeFileSync(proceed, "go");
        }
        const result = await pending;
        expect(result.code, result.stderr).toBe(0);
        fence.assertCurrent();
      });
      if (mode === "healthy") {
        await operation;
        expect(fs.readFileSync(output, "utf8")).toBe("owned");
        const store = createManagedHandoffLeaseStore();
        expect(store.read(original).kind).toBe("absent");
        expect(store.read(slot).kind).toBe("absent");
      } else {
        await expect(operation).rejects.toThrow();
        expect(fs.existsSync(output)).toBe(false);
      }
    },
    30_000,
  );

  it("refuses an unrelated slot without acquiring its domain", async () => {
    const foreign = path.join(home, "foreign");
    fs.mkdirSync(foreign);
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(original);
      expect(() => reserveUpdateCommandExecutorSlot(fence, foreign)).toThrow("does not resolve");
      expect(createManagedHandoffLeaseStore().read(foreign).kind).toBe("absent");
      fence.assertCurrent();
    });
  });

  it("releases paired roots atomically on a real store refusal", async () => {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(slot);
      reserveUpdateCommandExecutorSlot(fence, slot);
      const store = createManagedHandoffLeaseStore();
      const a = store.read(original);
      const s = store.read(slot);
      assert(a.kind === "current" && s.kind === "current", "Both roots are held");
      const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
      try {
        db.exec(
          `CREATE TRIGGER refuse_slot_release BEFORE DELETE ON managed_update_handoffs WHEN old.install_root = '${slot}' BEGIN SELECT RAISE(ABORT, 'slot release denied'); END`,
        );
        expect(() => store.releaseAll([a.lease, s.lease])).toThrow("slot release denied");
        expect(store.current(a.lease)).toBe(true);
        expect(store.current(s.lease)).toBe(true);
        db.exec("DROP TRIGGER refuse_slot_release");
      } finally {
        db.close();
      }
    });
  });

  it("rolls back both child bindings when the second row refuses its update", async () => {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(slot);
      reserveUpdateCommandExecutorSlot(fence, slot);
      const store = createManagedHandoffLeaseStore();
      const a = store.acquire(`${original}/.openclaw-update-child-a`, randomUUID(), {
        kind: "update",
      });
      const s = store.acquire(`${slot}/.openclaw-update-child-s`, randomUUID(), { kind: "update" });
      assert(a.kind === "acquired" && s.kind === "acquired", "Both child reservations exist");
      const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      const closed = once(child, "close");
      const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
      try {
        assert(child.pid, "Actual subprocess required");
        db.exec(
          `CREATE TRIGGER refuse_slot_bind BEFORE UPDATE ON managed_update_handoffs WHEN old.install_root = '${s.lease.key}' BEGIN SELECT RAISE(ABORT, 'slot bind denied'); END`,
        );
        expect(() => store.bindUpdateChildren([a.lease, s.lease], child.pid!)).toThrow(
          "slot bind denied",
        );
        expect(store.current(a.lease)).toBe(true);
        expect(store.current(s.lease)).toBe(true);
        assertExcluded();
        db.exec("DROP TRIGGER refuse_slot_bind");
      } finally {
        db.close();
        child.stdin.end();
        await closed;
      }
      expect(store.releaseAll([a.lease, s.lease])).toBe(true);
      fence.assertCurrent();
    });
  });

  it("preserves the operation and paired-release failure without deleting either root", async () => {
    const operationError = new Error("original operation failed");
    const store = createManagedHandoffLeaseStore();
    let database: DatabaseSync | undefined;
    let caught: unknown;
    try {
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(slot);
        database = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
        database.exec(
          `CREATE TRIGGER refuse_slot_release BEFORE DELETE ON managed_update_handoffs WHEN old.install_root = '${slot}' BEGIN SELECT RAISE(ABORT, 'slot release denied'); END`,
        );
        throw operationError;
      });
    } catch (error) {
      caught = error;
    }
    try {
      assert(
        caught instanceof Error && caught.cause instanceof AggregateError,
        "Both failures must be preserved",
      );
      expect(caught.cause.errors[0]).toBe(operationError);
      expect(caught.cause.errors[1]).toMatchObject({
        message: expect.stringContaining("slot release denied"),
      });
      assertExcluded();
    } finally {
      database?.exec("DROP TRIGGER refuse_slot_release");
      database?.close();
      const a = store.read(original),
        s = store.read(slot);
      if (a.kind === "current" && s.kind === "current") {
        store.releaseAll([a.lease, s.lease]);
      }
    }
  });

  it.each([false, true])(
    "keeps both roots excluded after the parent dies with a live descendant (nested=%s)",
    async (nested) => {
      const authority = await withUpdateCommandExecutor(randomUUID(), async (executor) =>
        captureUpdateCommandExecutorAuthority(await executor.enter(original)),
      );
      const info = path.join(home, "child.json");
      const proceed = path.join(home, "proceed");
      const output = path.join(home, "effect");
      const parentProgram = `
      import fs from 'node:fs';
      import {withUpdateCommandExecutor,withUpdateCommandExecutorChild,reserveUpdateCommandExecutorSlot} from ${JSON.stringify(moduleUrl)};
      import {runUtf8CommandWithTimeout} from ${JSON.stringify(execUrl)};
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      await withUpdateCommandExecutor(input.runId,async executor=>{
        const fence=await executor.enter(input.original);
        reserveUpdateCommandExecutorSlot(fence,input.root);
        fs.unlinkSync(input.root);fs.mkdirSync(input.root);
        await withUpdateCommandExecutorChild(fence,(grant,beforeInput)=>runUtf8CommandWithTimeout(input.argv,{
          input:JSON.stringify({...input,grant}),beforeInput,
          timeoutMs:20000,killProcessTree:true,requireProcessTreeExtinction:true,
        }));
      },{existingAuthority:input.authority});
    `;
      const parent = spawn(
        process.execPath,
        ["--import", loader, "--input-type=module", "-e", parentProgram],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      const closed = once(parent, "close");
      let diagnostics = "";
      parent.stderr.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      parent.stdin.end(
        JSON.stringify({
          runId: randomUUID(),
          authority,
          original,
          root: slot,
          argv: command,
          nested,
          info,
          proceed,
          output,
        }),
      );
      let child: { pid: number; startIdentity: string } | undefined;
      let spawner: { pid: number; startIdentity: string } | undefined;
      try {
        await vi.waitFor(() => expect(fs.existsSync(info), diagnostics).toBe(true), {
          timeout: 20_000,
          interval: 25,
        });
        const observed = JSON.parse(fs.readFileSync(info, "utf8")) as {
          grant: UpdateCommandChildGrant;
          pid: number;
        };
        const store = createManagedHandoffLeaseStore();
        const row = store.read(observed.grant.childKey);
        assert(row.kind === "current", "Bound child row required");
        child = row.lease.executor;
        if (nested) {
          assert(observed.grant.spawner && observed.grant.slot, "Nested paired spawners required");
          spawner = observed.grant.spawner.executor;
          expect(store.readProcessStartIdentity(spawner.pid)).toBe(spawner.startIdentity);
        }
        parent.kill("SIGKILL");
        await closed;
        if (spawner) {
          process.kill(spawner.pid, "SIGKILL");
          await waitForPidToExit(spawner.pid);
          for (const intermediate of [observed.grant.spawner!, observed.grant.slot!.spawner]) {
            expect(store.acquire(intermediate.key, randomUUID(), { kind: "update" }).kind).toBe(
              "busy",
            );
          }
        }
        expect(store.isPidAlive(child.pid)).toBe(true);
        assertExcluded();
      } finally {
        fs.writeFileSync(proceed, "go");
        if (parent.exitCode === null && parent.signalCode === null) {
          parent.kill("SIGKILL");
        }
        await closed;
        if (spawner && !createManagedHandoffLeaseStore().isPidAlive(spawner.pid)) {
          await vi.waitFor(() => expect(isChildProcessTreeAlive(spawner!)).toBe(false), {
            timeout: 5000,
            interval: 25,
          });
        }
        if (child) {
          await waitForPidToExit(child.pid);
          await vi.waitFor(() => expect(isChildProcessTreeAlive(child!)).toBe(false), {
            timeout: 5000,
            interval: 25,
          });
        }
      }
      expect(fs.existsSync(output)).toBe(false);
    },
    30_000,
  );
});
