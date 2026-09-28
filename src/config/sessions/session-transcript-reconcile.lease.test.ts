import { MessageChannel, type Worker, type MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readOpenClawAgentIntegrityVerification } from "../../state/openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import { closeSessionTranscriptReconcileWorkerPool } from "./session-transcript-reconcile-pool.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
import type {
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const options = { agentId: "main" };
const scope = { ...options, sessionId: "lease-failure", sessionKey: "agent:main:lease-failure" };

it("preserves verification until the writer closes after read-only reconciliation", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-reconcile-verification-") };
  await withEnvAsync(env, async () => {
    try {
      await persistSessionTranscriptTurn(scope, {
        messages: [{ eventId: "seed", message: { role: "user", content: "lease fixture" } }],
        touchSessionEntry: false,
      });
      await waitForSessionTranscriptIndexReconcile(options);
      const database = openOpenClawAgentDatabase(options);
      expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(0);
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(1);
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });
});

it.each([
  "startup",
  "claim-before",
  "claim-after",
  "release-exit",
  "release-error",
  "release-delete",
  "planner-ack",
] as const)(
  "reports %s failure after joining failed workers and exact lease cleanup",
  async (fault) => {
    const stateDir = tempDirs.make("openclaw-reconcile-lease-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const workers: Worker[] = [];
      const ports: MessagePort[] = [];
      const modes: SessionTranscriptReconcileWorkerInput["mode"][] = [];
      let leaseId: string | undefined;
      let canonicalLeaseId: string | undefined;
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      const admissionSpy = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((request, grant) => {
            if (
              request.stage === "open" &&
              isRecord(request.facts) &&
              typeof request.facts.leaseId === "string"
            ) {
              canonicalLeaseId = request.facts.leaseId;
            }
            admit(request, grant);
          }, attachment),
        );
      const rejectLeaseRelease = new Int32Array(new SharedArrayBuffer(4));
      try {
        await persistSessionTranscriptTurn(scope, {
          messages: [{ eventId: "seed", message: { role: "user", content: "lease fixture" } }],
          touchSessionEntry: false,
        });
        await waitForSessionTranscriptIndexReconcile(options);
        const database = openOpenClawAgentDatabase(options);
        database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
        const state = openOpenClawStateDatabase();
        const readLeases = () =>
          state.db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id").all();
        const baseline = readLeases();
        let leasesAtNativeFault: ReturnType<typeof readLeases> | undefined;
        expect(baseline).toHaveLength(1);
        let creations = 0;
        observer.beforeCreate = (filename, workerOptions) => {
          const planner = creations++ === 0;
          if (fault === "startup" && planner) {
            // Bun follow-up (oven-sh/bun#43222): Restore a missing entry once Bun closes ports
            // transferred before worker entry resolution fails.
            return {
              filename: "throw new Error('planner startup fixture')",
              options: { ...workerOptions, eval: true },
            };
          }
          if (!planner && (fault === "release-exit" || fault === "release-error")) {
            return {
              filename:
                fault === "release-exit"
                  ? "process.exit(0)"
                  : "throw new Error('cleanup worker fixture')",
              options: { ...workerOptions, eval: true },
            };
          }
          if (planner && (fault === "claim-before" || fault === "claim-after")) {
            const channel = new MessageChannel();
            ports.push(channel.port1, channel.port2);
            channel.port1.once("message", () => {
              leasesAtNativeFault = readLeases();
              void workers[0]!.terminate();
            });
            return {
              filename: `const {workerData}=require('node:worker_threads');
               const {DatabaseSync}=require('node:sqlite');
               const prepare=DatabaseSync.prototype.prepare, exec=DatabaseSync.prototype.exec;
               let leaseDatabase;
               const pause=()=>{
                 workerData.proofPort.postMessage('paused');
                 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
               };
               DatabaseSync.prototype.prepare=function(sql){
                 const statement=prepare.call(this,sql);
                 if(sql.startsWith('insert into "agent_database_leases"')) {
                   const run=statement.run.bind(statement), database=this;
                   statement.run=(...args)=>{
                     if(${JSON.stringify(fault)}==='claim-before') pause();
                     const result=run(...args); leaseDatabase=database; return result;
                   };
                 }
                 return statement;
               };
               DatabaseSync.prototype.exec=function(sql){
                 const result=exec.call(this,sql);
                 if(this===leaseDatabase && sql==='COMMIT' && ${JSON.stringify(fault)}==='claim-after') pause();
                 return result;
               };
               void import(${JSON.stringify(String(filename))});`,
              options: {
                ...workerOptions,
                workerData: { proofPort: channel.port2 },
                transferList: [channel.port2],
                eval: true,
              },
            };
          }
          if (planner && fault === "planner-ack") {
            // Native exit after the canonical DELETE commits, immediately before its ACK.
            return {
              filename: `const {MessagePort}=require('node:worker_threads');
               const post=MessagePort.prototype.postMessage;
               MessagePort.prototype.postMessage=function(message,...args){
                 if(message.type==='lease-released') process.exit(0);
                 return post.call(this,message,...args);
               };
               void import(${JSON.stringify(String(filename))});`,
              options: { ...workerOptions, eval: true },
            };
          }
          if (planner && fault === "release-delete") {
            // Fail the real DELETE without changing the admitted main schema.
            return {
              filename: `const {workerData}=require('node:worker_threads');
               const {DatabaseSync}=require('node:sqlite');
               const rejected=new Int32Array(workerData.rejectLeaseRelease);
               const prepare=DatabaseSync.prototype.prepare;
               DatabaseSync.prototype.prepare=function(sql){
                 const statement=prepare.call(this,sql);
                 if(sql.startsWith('delete from "agent_database_leases"')) {
                   const run=statement.run.bind(statement), database=this;
                   statement.run=(...args)=>{
                     if(Atomics.load(rejected,0)) {
                       const leaseId=args[0];
                       if(typeof leaseId!=='string'||!/^[a-f0-9-]+$/u.test(leaseId)) throw new Error('unexpected lease fixture binding');
                       database.exec("CREATE TEMP TRIGGER IF NOT EXISTS reject_test_lease_release BEFORE DELETE ON main.agent_database_leases WHEN OLD.lease_id = '"+leaseId+"' BEGIN SELECT RAISE(FAIL, 'lease release fixture'); END;");
                     } else {
                       database.exec('DROP TRIGGER IF EXISTS temp.reject_test_lease_release');
                     }
                     return run(...args);
                   };
                 }
                 return statement;
               };
               void import(${JSON.stringify(String(filename))});`,
              options: {
                ...workerOptions,
                workerData: { rejectLeaseRelease: rejectLeaseRelease.buffer },
                eval: true,
              },
            };
          }
          return { filename, options: workerOptions };
        };
        observer.onTask = ({ input, worker, observeMessage }) => {
          modes.push(input.mode);
          if (!workers.includes(worker)) {
            workers.push(worker);
          }
          if (input.mode === "disk") {
            leaseId = input.leaseId;
          }
          observeMessage((message: SessionTranscriptReconcileWorkerMessage) => {
            if (input.mode !== "disk" || message.type !== "plan-start") {
              return;
            }
            if (fault === "release-exit" || fault === "release-error") {
              void worker.terminate();
            } else if (fault === "release-delete") {
              expect(input.leaseId).toMatch(/^[a-f0-9-]+$/u);
              Atomics.store(rejectLeaseRelease, 0, 1);
            }
          });
        };
        const result = await reconcileSessionTranscriptIndexes(options).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
          throw new Error("native failure was reported as success");
        }
        if (fault === "release-delete") {
          expect(workers[0]?.threadId).toBeGreaterThan(0);
          expect(result.error).toMatchObject({
            message: expect.stringContaining("lease release fixture"),
          });
        } else {
          expect(workers[0]?.threadId).toBe(-1);
          if (fault === "release-exit" || fault === "release-error") {
            expect(workers[1]?.threadId).toBe(-1);
          } else {
            expect(workers[1]?.threadId).toBeGreaterThan(0);
          }
        }
        expect(modes).toEqual(fault === "release-delete" ? ["disk"] : ["disk", "release"]);
        expect(canonicalLeaseId).toMatch(/^[a-f0-9-]+$/u);
        expect(canonicalLeaseId).not.toBe(leaseId);
        const writerLeases = [...baseline, { lease_id: canonicalLeaseId }].toSorted((a, b) =>
          String(a.lease_id).localeCompare(String(b.lease_id)),
        );
        if (fault === "claim-before") {
          expect(leasesAtNativeFault).toEqual(writerLeases);
        } else if (fault === "claim-after") {
          expect(leasesAtNativeFault).toEqual(
            [...writerLeases, { lease_id: leaseId }].toSorted((a, b) =>
              String(a.lease_id).localeCompare(String(b.lease_id)),
            ),
          );
          expect(leasesAtNativeFault).toContainEqual({ lease_id: leaseId });
        }
        if (fault === "release-delete" || fault === "release-exit" || fault === "release-error") {
          expect(result.error).toMatchObject({
            message: expect.stringContaining("cleanup incomplete"),
          });
          expect(readLeases()).toEqual(
            [...writerLeases, { lease_id: leaseId }].toSorted((a, b) =>
              String(a.lease_id).localeCompare(String(b.lease_id)),
            ),
          );
          await expect(closeOpenClawAgentDatabaseByPathAsync(database.path)).rejects.toThrow(
            "Agent database resource drainage failed",
          );
          expect(database.db.isOpen).toBe(true);
          observer.beforeCreate = undefined;
          observer.onTask = undefined;
          Atomics.store(rejectLeaseRelease, 0, 0);
          const closing = closeOpenClawAgentDatabaseByPathAsync(database.path);
          const poolClosing = closeSessionTranscriptReconcileWorkerPool();
          await expect(closing).resolves.toBe(true);
          await poolClosing;
          expect(readLeases()).toEqual([]);
        } else {
          expect(String(result.error)).not.toContain("cleanup incomplete");
          expect(readLeases()).toEqual(writerLeases);
        }
      } finally {
        admissionSpy.mockRestore();
        Atomics.store(rejectLeaseRelease, 0, 0);
        await Promise.all(workers.map((worker) => worker.terminate()));
        for (const port of ports) {
          port.close();
        }
        observer.beforeCreate = undefined;
        observer.onTask = undefined;
        await closeOpenClawAgentDatabasesAsync(stateDir);
        await closeOpenClawStateDatabaseAsync();

        closeOpenClawStateDatabaseForTest();
      }
    });
  },
  20_000,
);
