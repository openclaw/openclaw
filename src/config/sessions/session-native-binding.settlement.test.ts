import assert from "node:assert/strict";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  createNativeSessionCommitFinalizer,
  wrapNativeSessionDeletionMutation,
} from "../../agents/harness/native-session/deletion-participant.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  withNativeBindingFixture,
  type NativeBindingClientTestApi,
} from "./session-native-binding.test-support.js";

const delivery = vi.hoisted(() => ({
  dispatched: 0,
  beforeExecution: undefined as (() => void) | undefined,
  afterExecution: undefined as ((value: unknown) => void) | undefined,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                async execute(command, commandOptions) {
                  if (command.type === "session.nativeBindings.delete") {
                    delivery.beforeExecution?.();
                    delivery.dispatched++;
                  }
                  const result = await worker.execute(command, commandOptions);
                  if (command.type === "session.nativeBindings.delete") {
                    delivery.afterExecution?.(result);
                  }
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});

afterEach(() => {
  delivery.dispatched = 0;
  delivery.beforeExecution = undefined;
  delivery.afterExecution = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("releases a binding after refusal before worker dispatch and permits a fresh deletion", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    const entry = fixture.readEntry();
    const binding = fixture.readBinding();
    const refused = new Error("synthetic refusal before native binding dispatch");
    let readiness = 0;
    const create = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        create((request, grant) => {
          const facts = isRecord(request.facts) ? request.facts.publication : undefined;
          if (isRecord(facts) && facts.kind === "native-binding-ready") {
            readiness++;
          }
          callback(request, grant);
        }, attachment),
    );
    const rejectDispatch = vi.fn(() => {
      const held = fixture.readBinding();
      expect(held).toMatchObject({
        ...binding,
        lease: { token: expect.any(String), expiresAt: expect.any(Number) },
      });
      throw refused;
    });
    delivery.beforeExecution = rejectDispatch;
    await expect(fixture.remove()).rejects.toBe(refused);
    expect(rejectDispatch).toHaveBeenCalledOnce();
    // No native command entered, so neither A nor its S participant could execute SQL.
    expect(delivery.dispatched).toBe(0);
    expect(readiness).toBe(0);
    expect(fixture.readEntry()).toEqual(entry);
    expect(fixture.readBinding()).toEqual(binding);

    delivery.beforeExecution = undefined;
    await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
    expect(delivery.dispatched).toBe(1);
    expect(readiness).toBe(1);
    expect(fixture.readEntry()).toBeUndefined();
    expect(fixture.readBinding()).toBeUndefined();
  });
});

it("does not finalize native custody from a mismatched actual A receipt", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    const finalized = vi.fn();
    const prepare = fixture.harness.withSessionDeletion;
    assert(prepare);
    fixture.harness.withSessionDeletion = (params, run) =>
      prepare(params, async (mutation) =>
        run(
          wrapNativeSessionDeletionMutation(mutation, {
            assertCurrent: params.assertCurrent,
            committed: finalized,
            rolledBack() {},
          }),
        ),
      );
    let native: admission.SqliteWorkerOperationAdmission | undefined;
    const create = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) => {
        const owned = create((request, grant) => {
          if (
            request.stage === "commit" &&
            isRecord(request.facts) &&
            isRecord(request.facts.publication) &&
            request.facts.publication.kind === "session-native-binding"
          ) {
            native = owned;
          }
          callback(request, grant);
        }, attachment);
        return owned;
      },
    );
    const corrupt = (value: unknown) => {
      assert(
        isRecord(value) && value.kind === "session-native-binding" && value.agent === "committed",
      );
      assert(isRecord(value.receipt) && typeof value.receipt.transferId === "number");
      value.receipt.transferId += 1;
    };
    delivery.afterExecution = (value) => {
      corrupt(value);
      corrupt(native?.committed?.facts);
    };
    await expect(fixture.remove()).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(delivery.dispatched).toBe(1);
    expect(fixture.readEntry()).toBeUndefined();
    expect(fixture.readBinding()).toBeUndefined();
    expect(finalized).not.toHaveBeenCalled();
    const replay = vi.fn(async () => undefined);
    await expect(
      fixture.harness.withSessionDeletion({ ...fixture.scope, assertCurrent() {} }, replay),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(replay).not.toHaveBeenCalled();
  });
});

it("joins a real pending heartbeat after readiness refusal and enters A and S only once", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let ready = 0;
    let sharedDelete = 0;
    let agentCommit = 0;
    const create = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        create((request, grant) => {
          const facts = isRecord(request.facts) ? request.facts.publication : undefined;
          if (isRecord(facts)) {
            if (facts.kind === "native-binding-ready" && ++ready === 1) {
              // Accept the actual heartbeat immediately before the synchronous readiness decision.
              vi.advanceTimersByTime(21_000);
            }
            if (
              facts.kind === "native-binding-storage" &&
              facts.phase === "delete" &&
              facts.stage === "transaction"
            ) {
              sharedDelete++;
            }
            if (request.stage === "commit" && facts.kind === "session-native-binding") {
              agentCommit++;
            }
          }
          callback(request, grant);
        }, attachment),
    );
    try {
      await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
      expect(ready).toBe(2);
      expect(delivery.dispatched).toBe(2);
      expect(sharedDelete).toBe(1);
      expect(agentCommit).toBe(1);
      expect(fixture.readEntry()).toBeUndefined();
      expect(fixture.readBinding()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("reconciles an actual A COMMIT after ordinary reply loss without replaying S deletion", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    let native: admission.SqliteWorkerOperationAdmission | undefined;
    const create = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) => {
        const owned = create((request, grant) => {
          if (
            request.stage === "commit" &&
            isRecord(request.facts) &&
            isRecord(request.facts.publication) &&
            request.facts.publication.kind === "session-native-binding"
          ) {
            native = owned;
          }
          callback(request, grant);
        }, attachment);
        return owned;
      },
    );
    const lostReply = new Error("synthetic native deletion reply lost");
    delivery.afterExecution = () => {
      expect(native?.committed?.facts).toMatchObject({
        kind: "session-native-binding",
        agent: "committed",
        bindings: ["deleted"],
      });
      throw lostReply;
    };
    const changes: string[] = [];
    const stop = onSessionIdentityMutation((change) => {
      if (
        change.kind === "delete" &&
        change.previous.sessionKeys.includes(fixture.scope.sessionKey)
      ) {
        changes.push(change.kind);
      }
    });
    try {
      await expect(fixture.remove()).resolves.toMatchObject({ deleted: true });
      expect(delivery.dispatched).toBe(1);
      expect(fixture.readEntry()).toBeUndefined();
      expect(fixture.readBinding()).toBeUndefined();
      expect(changes).toEqual(["delete"]);
    } finally {
      stop();
    }
  });
});

it.each([
  { checkpoint: "S commit", kind: "agentsapi" },
  { checkpoint: "A commit", kind: "agentsapi" },
  { checkpoint: "A commit", kind: "codex" },
  { checkpoint: "A commit", kind: "acp" },
] as const)(
  "blocks the original $kind generation after actual worker loss at $checkpoint without replay or compensation",
  async ({ checkpoint, kind }) => {
    await withNativeBindingFixture(kind === "codex" ? "codex" : "agentsapi", async (fixture) => {
      const finalized = vi.fn();
      const rolledBack = vi.fn();
      if (kind === "acp") {
        fixture.bindingStore.delete(fixture.bindingKey);
        fixture.harness.withSessionDeletion = (_params, run) =>
          run(createNativeSessionCommitFinalizer({ commit: finalized, rollback: rolledBack }));
      }
      const original = fixture.readEntry();
      assert(original);
      const nativeClient =
        kind === "codex"
          ? await (
              await loadBundledPluginFacade<NativeBindingClientTestApi>({
                pluginId: "codex",
                artifactBasename: "native-session-binding.test-api.js",
              })
            ).attachNativeBindingDeletionClient(fixture.bindingStore, fixture.bindingKey)
          : undefined;
      let terminateWorker: (() => Promise<number>) | undefined;
      let stopped: Promise<number> | undefined;
      // The interceptor forwards the original method with its exact Worker receiver below.
      // oxlint-disable-next-line typescript/unbound-method
      const posted = Worker.prototype.postMessage;
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
            terminateWorker = () => this.terminate();
          }
        }
        return Reflect.apply(posted, this, args);
      });
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            const facts = isRecord(request.facts) ? request.facts.publication : undefined;
            const atCheckpoint =
              isRecord(facts) &&
              (checkpoint === "S commit"
                ? facts.kind === "native-binding-storage" &&
                  facts.phase === "delete" &&
                  facts.stage === "commit"
                : request.stage === "commit" && facts.kind === "session-native-binding");
            if (atCheckpoint && !stopped) {
              assert(terminateWorker, "native deletion must dispatch before its commit grant");
              stopped = terminateWorker();
              throw new Error("synthetic native worker termination");
            }
            callback(request, grant);
          }, attachment),
      );
      try {
        const deletion = fixture.remove();
        await expect(deletion).rejects.toBeInstanceOf(SqliteWorkerError);
        await expect(deletion).rejects.toMatchObject({ code: "outcome-unknown" });
        assert(stopped, "the test must reach the requested native commit checkpoint");
        await stopped;
        expect(delivery.dispatched).toBe(1);
        expect(fixture.readEntry()).toEqual(original);
        if (checkpoint === "S commit") {
          expect(fixture.readBinding()).toMatchObject({ lease: { token: expect.any(String) } });
        } else {
          expect(fixture.readBinding()).toBeUndefined();
        }
        await expect(fixture.remove()).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(delivery.dispatched).toBe(1);
        expect(finalized).not.toHaveBeenCalled();
        expect(rolledBack).not.toHaveBeenCalled();
        if (nativeClient) {
          expect(nativeClient.release).not.toHaveBeenCalled();
          expect(nativeClient.request).not.toHaveBeenCalled();
          expect(nativeClient.subscribed()).toBe(true);
        }
      } finally {
        await stopped;
        nativeClient?.close();
      }
    });
  },
);
