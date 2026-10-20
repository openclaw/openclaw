import assert from "node:assert/strict";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentDeletion } from "../../agents/agent-lifecycle-registry.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { purgeDeletedAgentSessionEntries } from "../../config/sessions/session-agent-purge.js";
import { createNativeBindingFixture } from "../../config/sessions/session-native-binding.test-support.js";
import { assertPluginStatePublicationSettled } from "../../plugin-state/plugin-state-publication.js";
import { markPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  readActiveOpenClawAgentDatabaseLeasesReadOnly,
} from "../../state/openclaw-agent-db-lease.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import * as admission from "../sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../sqlite-worker-owner-probe.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

const isSharedDeleteCommit = (facts: Record<string, unknown>) =>
  facts.kind === "native-binding-storage" && facts.phase === "delete" && facts.stage === "commit";

function observeNativeGrants(
  observe: (
    request: admission.SqliteWorkerAdmissionRequest,
    publication: Record<string, unknown>,
  ) => void,
) {
  return probe.admission(admission, (request, grant, admit) => {
    if (isRecord(request.facts) && isRecord(request.facts.publication)) {
      observe(request, request.facts.publication);
    }
    admit(request, grant);
  });
}

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!mixedAgentConnection).each(mixedAgentPairs)(
  "state=$stateEngine agent=$agentEngine lifecycle conformance",
  ({ stateEngine, agentEngine }) => {
    const pair = useMixedAgentPair(stateEngine, agentEngine);
    let sequence = 0;
    const env = () => ({ ...process.env, OPENCLAW_STATE_DIR: pair.root });
    const inAdmission = withEngineStoreAdmission;
    const withBinding = async (
      run: (fixture: Awaited<ReturnType<typeof createNativeBindingFixture>>) => Promise<void>,
      stateDir = pair.root,
    ) => {
      const fixture = await createNativeBindingFixture(
        "agentsapi",
        "worker",
        { ...env(), OPENCLAW_STATE_DIR: stateDir },
        `mixed-binding-${++sequence}`,
      );
      try {
        await run(fixture);
      } finally {
        markPluginRegistryRetired(fixture.registry);
        await fixture.harness.dispose?.();
      }
    };

    it("records agent leases in the selected shared owner and releases them on close", () => {
      inAdmission(() => {
        const options = { agentId: "leased", env: env() };
        const database = openOpenClawAgentDatabase(options);
        const shared = openOpenClawStateDatabase(options);
        expect(isPostgresSqlConnection(database.db)).toBe(agentEngine === "postgres");
        expect(isPostgresSqlConnection(shared.db)).toBe(stateEngine === "postgres");
        const expectLease = (pathname: string) =>
          expect(readActiveOpenClawAgentDatabaseLeasesReadOnly(options)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ agent_id: "leased", path: pathname }),
            ]),
          );
        expectLease(database.path);
        expect(() => assertNoOpenClawAgentDatabaseLeases("leased", options)).toThrow(/still open/);
        expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        expect(() => assertNoOpenClawAgentDatabaseLeases("leased", options)).not.toThrow();
        const reopened = openOpenClawAgentDatabase(options);
        expectLease(reopened.path);
        closeOpenClawAgentDatabaseByPath(reopened.path);
      });
    });

    it("vetoes a binding that loses live authority before either deletion commits", async () => {
      await withBinding(async (fixture) => {
        const entry = fixture.readEntry();
        const binding = fixture.readBinding();
        let vetoReached = false;
        observeNativeGrants((_request, facts) => {
          if (facts.kind !== "native-binding-ready" || vetoReached) {
            return;
          }
          vetoReached = true;
          const held = fixture.readBinding();
          inAdmission(() =>
            fixture.bindingStore.register(fixture.bindingKey, {
              ...held,
              lease: { ...(isRecord(held?.lease) ? held.lease : {}), expiresAt: 1 },
            }),
          );
        });
        await expect(fixture.remove()).rejects.toThrow("binding changed before session deletion");
        expect(vetoReached).toBe(true);
        expect(fixture.readEntry()).toEqual(entry);
        expect(fixture.readBinding()).toMatchObject(binding!);
      });
    });

    it("compensates a committed shared binding only after a confirmed agent rollback", async () => {
      await withBinding(async (fixture) => {
        const entry = fixture.readEntry();
        const binding = fixture.readBinding();
        const refusal = new Error("synthetic mixed agent commit refusal");
        let sharedDelete = false;
        let agentCommit = false;
        const interception = observeNativeGrants((request, facts) => {
          if (isSharedDeleteCommit(facts)) {
            sharedDelete = true;
          }
          if (request.stage === "commit" && facts.kind === "session-native-binding") {
            agentCommit = true;
            expect(sharedDelete).toBe(true);
            expect(fixture.readBinding()).toBeUndefined();
            throw refusal;
          }
        });
        await expect(fixture.remove()).rejects.toBe(refusal);
        expect(agentCommit).toBe(true);
        expect(fixture.readEntry()).toEqual(entry);
        expect(fixture.readBinding()).toMatchObject(binding!);
        interception.mockRestore();
        await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
        expect(fixture.readEntry()).toBeUndefined();
        expect(fixture.readBinding()).toBeUndefined();
      });
    });

    it("holds the shared retirement guard through the actual agent commit", async () => {
      await captureRuntimeConfigAsyncReader()();
      const options = { agentId: "retiring", env: env() };
      const scope = { ...options, sessionKey: "agent:retiring:main" };
      await upsertSessionEntryCore(scope, { sessionId: "retirement-before", updatedAt: 1 });
      const database = inAdmission(() => openOpenClawAgentDatabase(options));
      const shared = inAdmission(() => openOpenClawStateDatabase(options));
      inAdmission(() => closeOpenClawAgentDatabaseByPath(database.path));
      const target = { agentId: options.agentId, path: database.path };
      const cfg = {
        agents: { entries: { retiring: {}, kept: {} } },
        session: { store: target.path, maintenance: { mode: "warn" as const } },
      };
      const foreignAnchor = openNodeSqliteDatabase(
        stateEngine === "sqlite" ? shared.path : ":memory:",
      );
      const physical = isPostgresSqlConnection(shared.db)
        ? getPostgresPhysicalFacts(shared.db)
        : undefined;
      const foreign = physical
        ? inAdmission(
            () =>
              new PostgresSyncConnection(
                mixedAgentConnection!,
                physical.namespace,
                foreignAnchor,
                physical.storeId,
              ),
          )
        : undefined;
      foreignAnchor.exec("PRAGMA busy_timeout = 0");
      let candidate = false;
      let held = false;
      probe.admission(admission, (request, grant, callback) => {
        const facts = isRecord(request.facts) ? request.facts : undefined;
        const publication = isRecord(facts?.publication) ? facts.publication : undefined;
        if (request.stage === "commit" && publication?.kind === "session-entry-patch-committed") {
          candidate = true;
        }
        if (candidate && !held && request.stage === "commit" && facts?.kind === "state-lease") {
          inAdmission(() => {
            if (foreign && isPostgresSqlConnection(shared.db)) {
              expect(
                foreign
                  .prepare("SELECT pg_try_advisory_xact_lock(?) AS held")
                  .get(shared.db.advisoryLockKey),
              ).toEqual({ held: 0 });
            } else {
              expect(() => foreignAnchor.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
            }
          });
          held = true;
        }
        callback(request, grant);
      });
      try {
        await withAgentDeletion(
          options.agentId,
          async (begin) => {
            const deletion = await begin({
              agentId: options.agentId,
              agentDir: path.dirname(database.path),
              workspaceDir: path.join(pair.root, "workspace"),
              sessionsDir: path.join(pair.root, "agents", options.agentId, "sessions"),
            });
            await deletion.runDatabaseCleanup(target, () =>
              purgeDeletedAgentSessionEntries({
                cfg,
                agentId: options.agentId,
                storeAgentId: options.agentId,
                storePath: target.path,
                env: options.env,
              }),
            );
          },
          { env: options.env },
        );
        expect(candidate).toBe(true);
        expect(held).toBe(true);
        expect(inAdmission(() => loadSessionEntryReadOnly(scope))).toBeUndefined();
      } finally {
        foreign?.close();
        foreignAnchor.close();
      }
    });

    it.each(["shared", "agent"] as const)(
      "keeps separate outcomes and refuses replay after worker loss at %s commit",
      async (checkpoint) => {
        const uncertainRoot = path.join(pair.root, `uncertain-${checkpoint}`);
        vi.stubEnv("OPENCLAW_STATE_DIR", uncertainRoot);
        try {
          await withBinding(async (fixture) => {
            const entry = fixture.readEntry();
            const identity = captureOpenClawStateWorkerContext({ env: fixture.scope.env }).admission
              .identity.key;
            let stopWorker: (() => Promise<number>) | undefined;
            let stopped: Promise<number> | undefined;
            // Forward with the original Worker receiver; intercept only this synthetic deletion.
            // oxlint-disable-next-line typescript/unbound-method
            const postMessage = Worker.prototype.postMessage;
            vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
              this: Worker,
              ...args
            ) {
              const message: unknown = args[0];
              if (
                isRecord(message) &&
                message.type === "execute" &&
                message.input instanceof Uint8Array
              ) {
                const command: unknown = deserialize(message.input);
                if (isRecord(command) && command.type === "session.nativeBindings.delete") {
                  stopWorker = () => this.terminate();
                }
              }
              return Reflect.apply(postMessage, this, args);
            });
            observeNativeGrants((request, facts) => {
              const atCheckpoint =
                checkpoint === "shared"
                  ? isSharedDeleteCommit(facts)
                  : request.stage === "commit" && facts.kind === "session-native-binding";
              if (atCheckpoint && !stopped) {
                assert(
                  stopWorker,
                  "the real deletion worker must reach the requested commit grant",
                );
                if (checkpoint === "agent") {
                  expect(fixture.readBinding()).toBeUndefined();
                }
                stopped = stopWorker();
                throw new Error("synthetic mixed worker loss");
              }
            });
            try {
              await expect(fixture.remove()).rejects.toMatchObject({ code: "outcome-unknown" });
              assert(stopped, "worker loss must occur at the requested real commit grant");
              await stopped;
              expect(fixture.readEntry()).toEqual(entry);
              if (checkpoint === "shared") {
                expect(fixture.readBinding()).toMatchObject({
                  lease: { token: expect.any(String) },
                });
              } else {
                expect(fixture.readBinding()).toBeUndefined();
              }
              expect(() => assertPluginStatePublicationSettled(identity)).toThrow(
                "authority is unavailable",
              );
              await expect(fixture.remove()).rejects.toMatchObject({ code: "outcome-unknown" });
            } finally {
              await stopped;
            }
          }, uncertainRoot);
        } finally {
          inAdmission(() => closeOpenClawAgentDatabases(uncertainRoot));
          await cleanupSessionStateForTest({ stateDir: uncertainRoot });
        }
      },
    );
  },
);
