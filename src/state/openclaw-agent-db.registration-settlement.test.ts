import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { MessagePort, type Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { createSessionRowProjection } from "../gateway/session-row-projection.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { isSessionStoreTopologyChange, sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawAgentDatabaseRegistrationCommit } from "./openclaw-agent-db-contract.js";
import * as registryListing from "./openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseAsync,
} from "./openclaw-state-db-cache.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const lostReceipt = vi.hoisted(() => ({
  agentId: "registration-lost-receipt",
  control: new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT),
  events: [] as string[],
}));
vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { MessagePort, workerData } from "node:worker_threads";
    const postMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...args) {
      const facts = message?.facts;
      const control = new Int32Array(workerData.registrationReceiptControl);
      if (facts?.kind === "agent-registration-committed" &&
          facts.registration.agentId === workerData.registrationReceiptAgent &&
          Atomics.compareExchange(control, 0, 1, 0) === 1) {
        // The real backend has committed; no receipt reaches the host admission port.
        Atomics.add(control, 1, 1);
        process.exit(37);
      }
      return postMessage.call(this, message, ...args);
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      const worker = actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          registrationReceiptAgent: lostReceipt.agentId,
          registrationReceiptControl: lostReceipt.control,
        },
      });
      worker.once("exit", (code) => {
        if (code === 37) {
          lostReceipt.events.push("native-exit");
        }
      });
      return worker;
    },
  };
});

const subscriptions = new Set<() => void>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    Atomics.store(new Int32Array(lostReceipt.control), 0, 0);
    for (const stop of subscriptions) {
      stop();
    }
    subscriptions.clear();
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function createFixture(
  env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-registration-commit-") },
) {
  const shared = openOpenClawStateDatabase({ env });
  const options = { agentId: "registration-commit", env };
  const target = { ...options, path: resolveOpenClawAgentSqlitePath(options) };
  const admission = captureOpenClawStateDatabaseReadAdmission(shared.path);
  const receipt: OpenClawAgentDatabaseRegistrationCommit = {
    agentId: target.agentId,
    agentPath: target.path,
    stateDatabasePath: shared.path,
    stateDatabaseIdentity: admission.identity.key,
  };
  const registrations = () => registryListing.readRegisteredAgentDatabases({ env }, false);
  return { env, shared, target, admission, receipt, registrations };
}

function observeStores(database: ReturnType<typeof openOpenClawStateDatabase>) {
  const trace: Array<{ kind: "commit" | "stores"; inTransaction: boolean }> = [];
  const facts: boolean[] = [];
  subscriptions.add(
    sessionChanges.subscribeFacts((change) => {
      if (isSessionStoreTopologyChange(change)) {
        facts.push(registryListing.isOpenClawAgentDatabaseRegistryChange(change));
      }
    }),
  );
  const stop = sessionChanges.subscribe((change) => {
    if (isSessionStoreTopologyChange(change)) {
      trace.push({ kind: "stores", inTransaction: database.db.isTransaction });
    }
  });
  subscriptions.add(stop);
  return { trace, stop, facts };
}

describe("agent registration native settlement", () => {
  it("refuses retained sharing facts when a worker loses its registration COMMIT receipt", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = lostReceipt.agentId;
      const sessionKey = `agent:${agentId}:existing`;
      const entry = { sessionId: "lost-registration-receipt", updatedAt: 1 };
      const stagingPath = state.statePath("imports", "lost-registration-receipt.sqlite");
      const shared = openOpenClawStateDatabase({ env: state.env });
      openOpenClawAgentDatabase({ agentId, path: stagingPath, env: state.env });
      replaceSessionEntrySync({ agentId, storePath: stagingPath, sessionKey }, entry);
      await closeOpenClawAgentDatabaseByPathAsync(stagingPath, agentId);
      const registrations = () =>
        registryListing.readRegisteredAgentDatabases({ env: state.env }, false);
      expect(registrations()).toEqual([]);
      const cfg = { agents: { entries: { main: {} } } };
      const prepared = await prepareSessionMutationFacts({
        cfg,
        agentId,
        sessionKey,
        allowMissing: true,
      });
      const control = new Int32Array(lostReceipt.control);
      lostReceipt.events.length = 0;
      Atomics.store(control, 1, 0);
      try {
        expect(prepared.readCurrent(cfg).target).toBeNull();
        const agentDir = state.statePath("agents", "Registration Lost Receipt");
        const storePath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
        mkdirSync(path.dirname(storePath), { recursive: true });
        mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
        renameSync(stagingPath, storePath);
        const observed = observeStores(shared);
        const receipts: OpenClawAgentDatabaseRegistrationCommit[] = [];
        const capture = registryListing.captureOpenClawAgentDatabaseRegistration;
        vi.spyOn(registryListing, "captureOpenClawAgentDatabaseRegistration").mockImplementation(
          (params) => {
            const owned = capture(params);
            return {
              ...owned,
              recordCommitted(receipt) {
                receipts.push(receipt);
                owned.recordCommitted(receipt);
              },
            };
          },
        );
        Atomics.store(control, 0, 1);
        const failure = await readSessionEntryInWorker(
          { agentId, sessionKey, storePath, env: state.env },
          () => {},
        ).catch((error: unknown) => {
          lostReceipt.events.push("read-rejected");
          return error;
        });
        expect(failure).toBeInstanceOf(Error);
        if (Atomics.load(control, 1) !== 1) {
          throw failure;
        }
        expect(Atomics.load(control, 1)).toBe(1);
        expect(lostReceipt.events).toEqual(["native-exit", "read-rejected"]);
        expect(receipts).toEqual([]);
        expect(registrations()).toEqual([expect.objectContaining({ agentId, path: storePath })]);
        // Neither fresh discovery nor global cleanup may rescue the retained reader.
        expect(() => prepared.readCurrent(cfg)).toThrow("Session access facts are unavailable");
        expect(observed.facts).toEqual([true]);
        const current = await prepareSessionMutationFacts({ cfg, agentId, sessionKey });
        try {
          expect(current.readCurrent(cfg).target.entry.sessionId).toBe(entry.sessionId);
        } finally {
          current.release();
        }
      } finally {
        Atomics.store(control, 0, 0);
        prepared.release();
      }
    });
  });

  it("publishes committed registration after only its schema scope ends", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = createFixture({ OPENCLAW_STATE_DIR: state.stateDir });
      const sessionKey = "agent:registration-commit:late-registration";
      const entry = { sessionId: "late-registration", updatedAt: 1, label: "committed" };
      const stagingPath = state.statePath("imports", "late-registration.sqlite");
      openOpenClawAgentDatabase({ ...fixture.target, path: stagingPath });
      replaceSessionEntrySync(
        { agentId: fixture.target.agentId, storePath: stagingPath, sessionKey },
        entry,
      );
      await closeOpenClawAgentDatabaseByPathAsync(stagingPath, fixture.target.agentId);
      expect(fixture.registrations()).toEqual([]);
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      try {
        await projection.ensureMaterialized();
        const query = {
          agentId: fixture.target.agentId,
          storePath: fixture.target.path,
          key: sessionKey,
        };
        expect(projection.capture(query)).toBeUndefined();
        mkdirSync(path.dirname(fixture.target.path), { recursive: true });
        renameSync(stagingPath, fixture.target.path);
        const prepared = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead(
          { env: fixture.env },
          () => false,
        );
        const snapshot = await prepared.read();
        expect(snapshot.result).toEqual({ status: "available", entries: [] });
        const observed = observeStores(fixture.shared);
        const endScope = createDeferredCore();
        let deliverCommitted: (() => void) | undefined;
        const receipts: OpenClawAgentDatabaseRegistrationCommit[] = [];
        const receiptErrors: unknown[] = [];
        const capture = registryListing.captureOpenClawAgentDatabaseRegistration;
        const registration = vi
          .spyOn(registryListing, "captureOpenClawAgentDatabaseRegistration")
          .mockImplementation((params) => {
            const owned = capture(params);
            return {
              ...owned,
              recordCommitted(receipt) {
                receipts.push(receipt);
                try {
                  owned.recordCommitted(receipt);
                } catch (error) {
                  receiptErrors.push(error);
                  throw error;
                }
              },
            };
          });
        let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
        let opening: Promise<unknown> | undefined;
        const scope = withExistingOpenClawStateSchema({ path: fixture.shared.path }, async () => {
          const retained = captureOpenClawAgentDatabaseExecution(fixture.target);
          execution = retained;
          const source: AgentDatabaseRequestExecutionSource = {
            assertCurrent: () => retained.assertCurrent(),
            createAdmission(binding) {
              return () => {
                // oxlint-disable-next-line typescript/unbound-method -- Forwarded below with the intercepted native MessagePort receiver.
                const on = MessagePort.prototype.on;
                const receive = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
                  this: MessagePort,
                  event,
                  listener,
                ) {
                  if (event !== "message") {
                    return on.call(this, event, listener);
                  }
                  return on.call(this, event, (message: unknown) => {
                    const facts = isRecord(message) ? message.facts : undefined;
                    if (
                      isRecord(message) &&
                      message.stage === "prepare" &&
                      isRecord(facts) &&
                      facts.kind === "agent-registration-committed"
                    ) {
                      // Pause before the normal receiver handles the real post-COMMIT receipt.
                      deliverCommitted = () => listener(message);
                      endScope.resolve();
                    } else {
                      listener(message);
                    }
                  });
                });
                try {
                  return {
                    nativeLocations: binding.nativeLocations,
                    admission: createSqliteWorkerOperationAdmission((request, grant) => {
                      binding.authorize(request);
                      retained.assertCurrent();
                      if (!grant()) {
                        throw new Error("Registration fixture lost admission");
                      }
                    }, binding.attachment),
                  };
                } finally {
                  receive.mockRestore();
                }
              };
            },
          };
          opening = retained.prepare(source).then(
            () => ({ ok: true }),
            (error: unknown) => ({ ok: false, error }),
          );
          void opening.then(() => endScope.resolve());
          await endScope.promise;
        });
        try {
          await scope;
          if (!deliverCommitted) {
            const result = await opening;
            if (isRecord(result) && "error" in result) {
              throw result.error;
            }
            throw new Error("Registration settled before its post-COMMIT receipt barrier");
          }
          expect(deliverCommitted).toBeTypeOf("function");
          deliverCommitted?.();
          deliverCommitted = undefined;
          expect(await opening).toEqual({
            ok: false,
            error: expect.anything(),
          });
          expect(receipts).toEqual([fixture.receipt]);
          expect(receiptErrors).toEqual([
            expect.objectContaining({
              message: "Existing shared-state schema admission has ended.",
            }),
          ]);
          expect(fixture.admission.assertCurrent).not.toThrow();
          expect(fixture.registrations()).toEqual([
            expect.objectContaining({ agentId: fixture.target.agentId, path: fixture.target.path }),
          ]);
          await projection.ensureMaterialized();
          expect(projection.capture(query)?.entry).toMatchObject(entry);
          expect(observed.trace).toEqual([{ kind: "stores", inTransaction: false }]);
          expect(snapshot.assertCurrent).toThrow(registryListing.AgentDatabaseRegistryChangedError);
        } finally {
          endScope.resolve();
          deliverCommitted?.();
          await Promise.allSettled([scope, opening]);
          registration.mockRestore();
          await execution?.release();
        }
      } finally {
        projection.dispose();
      }
    });
  });
});
