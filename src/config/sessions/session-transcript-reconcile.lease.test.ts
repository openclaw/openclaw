import { MessageChannel, type Worker, type MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { readSqliteDatabaseCleanClose } from "../../infra/sqlite-database-admission.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  markRebuild,
  rows,
  seedTranscript,
  useReconcileTestRuntime,
} from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import type { SessionTranscriptReconcileWorkerInput } from "./session-transcript-reconcile.worker.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const { observer, tempDirs } = useReconcileTestRuntime();
const options = { agentId: "main" };
const scope = { ...options, sessionId: "lease-failure", sessionKey: "agent:main:lease-failure" };

it.each(["startup", "claim-before", "claim-after", "planner-ack"] as const)(
  "reports %s failure after joining failed workers and exact lease cleanup",
  async (fault) => {
    const stateDir = tempDirs.make("openclaw-reconcile-lease-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({});
      const workers: Worker[] = [];
      const ports: MessagePort[] = [];
      const modes: SessionTranscriptReconcileWorkerInput["mode"][] = [];
      let leaseId: string | undefined;
      let canonicalLeaseId: string | undefined;
      const admissionSpy = probe.admission(admission, (request, grant, admit) => {
        if (
          request.stage === "open" &&
          isRecord(request.facts) &&
          typeof request.facts.leaseId === "string"
        ) {
          canonicalLeaseId = request.facts.leaseId;
        }
        admit(request, grant);
      });
      try {
        await seedTranscript(scope, "seed", "lease fixture");
        await waitForSessionTranscriptIndexReconcile(options);
        const seeded = openOpenClawAgentDatabase(options);
        expect(readSqliteDatabaseCleanClose(seeded.path)).toBe(false);
        await closeOpenClawAgentDatabaseByPathAsync(seeded.path);
        expect(readSqliteDatabaseCleanClose(seeded.path)).toBe(true);
        const database = openOpenClawAgentDatabase(options);
        markRebuild(database.db);
        const state = openOpenClawStateDatabase();
        const readLeases = () =>
          rows(state.db, "SELECT lease_id FROM agent_database_leases ORDER BY lease_id");
        const baseline = readLeases();
        let leasesAtNativeFault: ReturnType<typeof readLeases> | undefined;
        expect(baseline).toHaveLength(1);
        let creations = 0;
        observer.beforeCreate = (filename, workerOptions) => {
          if (creations++ !== 0) {
            return { filename, options: workerOptions };
          }
          if (fault === "startup") {
            // Bun follow-up (oven-sh/bun#43222): Restore a missing entry once Bun closes ports
            // transferred before worker entry resolution fails.
            return {
              filename: "throw new Error('planner startup fixture')",
              options: { ...workerOptions, eval: true },
            };
          }
          if (fault === "claim-before" || fault === "claim-after") {
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
        };
        observer.onTask = ({ input, worker }) => {
          modes.push(input.mode);
          if (!workers.includes(worker)) {
            workers.push(worker);
          }
          if (input.mode === "disk") {
            leaseId = input.leaseId;
          }
        };
        const failure = await reconcileSessionTranscriptIndexes(options).then(
          () => {
            throw new Error("native failure was reported as success");
          },
          (error: unknown) => error,
        );
        expect(workers[0]?.threadId).toBe(-1);
        expect(workers[1]?.threadId).toBeGreaterThan(0);
        expect(modes).toEqual(["disk", "release"]);
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
        }
        expect(String(failure)).not.toContain("cleanup incomplete");
        expect(readLeases()).toEqual(writerLeases);
      } finally {
        admissionSpy.mockRestore();
        await Promise.all(workers.map((worker) => worker.terminate()));
        for (const port of ports) {
          port.close();
        }
        observer.beforeCreate = undefined;
        observer.onTask = undefined;
        await closeOpenClawAgentDatabasesAsync(stateDir);
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        clearRuntimeConfigSnapshot();
      }
    });
  },
  20_000,
);
