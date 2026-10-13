import assert from "node:assert/strict";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { PluginStateStoreError } from "../../plugin-state/plugin-state-store.types.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import {
  withNativeBindingFixture,
  type NativeBindingClientTestApi,
} from "./session-native-binding.test-support.js";

const delivery = vi.hoisted(() => ({
  dispatched: 0,
  accepted: 0,
  acceptedDispatch: undefined as number | undefined,
  afterExecution: undefined as (() => void | Promise<void>) | undefined,
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
                  const dispatch =
                    command.type === "session.messageCut.commit"
                      ? ++delivery.dispatched
                      : undefined;
                  try {
                    return await worker.execute(command, commandOptions);
                  } finally {
                    if (dispatch !== undefined && dispatch === delivery.acceptedDispatch) {
                      await delivery.afterExecution?.();
                    }
                  }
                },
              }),
            options,
          ),
      };
    },
  };
});

// Load the plugin graph during collection; each fixture still owns its storage and runtime.
const nativeBindingClient = await loadBundledPluginFacade<NativeBindingClientTestApi>({
  pluginId: "codex",
  artifactBasename: "native-session-binding.test-api.js",
});

afterEach(() => {
  delivery.dispatched = 0;
  delivery.accepted = 0;
  delivery.acceptedDispatch = undefined;
  delivery.afterExecution = undefined;
  vi.restoreAllMocks();
});

type Fixture = Parameters<Parameters<typeof withNativeBindingFixture>[1]>[0];

function withCutFixture(run: (fixture: Fixture) => Promise<void>) {
  return withNativeBindingFixture("codex", async (fixture) => {
    replaceTranscriptEventsSync(fixture.scope, [
      ...fixture.events,
      {
        type: "message",
        id: "synthetic-active",
        parentId: "synthetic-user",
        message: { role: "assistant", content: "Active answer", timestamp: 2 },
      },
      {
        type: "message",
        id: "synthetic-alternate",
        parentId: "synthetic-user",
        message: { role: "assistant", content: "Alternate answer", timestamp: 3 },
      },
      {
        type: "leaf",
        id: "synthetic-visible",
        parentId: "synthetic-alternate",
        targetId: "synthetic-active",
      },
    ]);
    await run(fixture);
  });
}

function observeNativeGrants(
  observe: (
    request: admission.SqliteWorkerAdmissionRequest,
    facts: Record<string, unknown>,
  ) => void,
) {
  probe.admission(admission, (request, grant, callback) => {
    const facts = isRecord(request.facts) ? request.facts.publication : undefined;
    if (isRecord(facts) && facts.kind === "native-binding-ready") {
      // Production joins renewal and quiesces the lease before invoking this grant.
      callback(request, () => {
        observe(request, facts);
        const accepted = grant();
        if (accepted) {
          delivery.accepted++;
          delivery.acceptedDispatch ??= delivery.dispatched;
        }
        return accepted;
      });
      return;
    }
    if (isRecord(facts)) {
      observe(request, facts);
    }
    callback(request, grant);
  });
}

function expectOneAcceptedExecution() {
  expect(delivery.accepted).toBe(1);
  expect(delivery.acceptedDispatch).toBeDefined();
  expect(delivery.dispatched).toBe(delivery.acceptedDispatch);
}

it("vetoes rewind before A COMMIT when the native binding delete fails", async () => {
  await withCutFixture(async (fixture) => {
    const original = fixture.readEntry();
    const history = loadTranscriptEventsSync(fixture.scope);
    let prepared = false;
    observeNativeGrants((_request, facts) => {
      if (facts.kind === "native-binding-ready" && !prepared) {
        prepared = true;
        fixture.shared.db
          .prepare(
            "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND entry_key = ?",
          )
          .run("{ corrupt synthetic binding", "codex", fixture.bindingKey);
      }
    });
    const failure = await fixture.cut("rewind", "synthetic-user").catch((error: unknown) => error);
    expect(prepared).toBe(true);
    expectOneAcceptedExecution();
    expect(failure).toBeInstanceOf(PluginStateStoreError);
    expect(failure).toMatchObject({ operation: "delete", code: "PLUGIN_STATE_CORRUPT" });
    expect(fixture.readEntry()).toEqual(original);
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(history);
  });
});

it("leaves a successor binding intact when rewind compensation cannot restore its predecessor", async () => {
  await withCutFixture(async (fixture) => {
    const original = fixture.readEntry();
    const history = loadTranscriptEventsSync(fixture.scope);
    const successor = {
      version: 1,
      state: "active",
      sessionId: "successor-generation",
      binding: { threadId: "successor-thread", cwd: "/synthetic/successor" },
    };
    let commitSeen = false;
    observeNativeGrants((request, facts) => {
      if (request.stage === "commit" && facts.kind === "session-native-binding") {
        commitSeen = true;
        expect(fixture.readBinding()).toBeUndefined();
        fixture.bindingStore.register(fixture.bindingKey, successor);
        throw new Error("synthetic rewind COMMIT refusal");
      }
    });
    await expect(fixture.cut("rewind", "synthetic-user")).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expect(commitSeen).toBe(true);
    expect(fixture.readEntry()).toEqual(original);
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(history);
    expect(fixture.readBinding()).toEqual(successor);
    await expect(fixture.cut("rewind", "synthetic-user")).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expectOneAcceptedExecution();
    expect(fixture.readBinding()).toEqual(successor);
  });
});

it("blocks branch switching after actual worker loss without releasing native subscription custody", async () => {
  await withCutFixture(async (fixture) => {
    const original = fixture.readEntry();
    const history = loadTranscriptEventsSync(fixture.scope);
    const client = await nativeBindingClient.attachNativeBindingDeletionClient(
      fixture.bindingStore,
      fixture.bindingKey,
    );
    let terminateWorker: (() => Promise<number>) | undefined;
    let stopped: Promise<number> | undefined;
    // Forward with the original receiver; terminate only the exact C3 command's worker.
    // oxlint-disable-next-line typescript/unbound-method
    const posted = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
      const message: unknown = args[0];
      if (isRecord(message) && message.type === "execute" && message.input instanceof Uint8Array) {
        const command: unknown = deserialize(message.input);
        if (isRecord(command) && command.type === "session.messageCut.commit") {
          terminateWorker = () => this.terminate();
        }
      }
      return Reflect.apply(posted, this, args);
    });
    observeNativeGrants((request, facts) => {
      if (request.stage === "commit" && facts.kind === "session-native-binding" && !stopped) {
        assert(terminateWorker);
        stopped = terminateWorker();
        throw new Error("synthetic branch worker termination");
      }
    });
    try {
      const cut = fixture.cut("switch", "synthetic-alternate");
      await expect(cut).rejects.toBeInstanceOf(SqliteWorkerError);
      await expect(cut).rejects.toMatchObject({ code: "outcome-unknown" });
      assert(stopped);
      await stopped;
      expect(fixture.readEntry()).toEqual(original);
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(history);
      expect(fixture.readBinding()).toBeUndefined();
      await expect(fixture.cut("switch", "synthetic-alternate")).rejects.toMatchObject({
        code: "outcome-unknown",
      });
      expectOneAcceptedExecution();
      expect(client.release).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
      expect(client.subscribed()).toBe(true);
    } finally {
      await stopped;
      client.close();
    }
  });
});

it.each([
  { mode: "rewind", entryId: "synthetic-user", leafId: null, loseReply: false },
  {
    mode: "switch",
    entryId: "synthetic-alternate",
    leafId: "synthetic-alternate",
    loseReply: true,
  },
] as const)(
  "settles $mode identity and subscription only after its delayed receipt (lost reply: $loseReply)",
  async ({ mode, entryId, leafId, loseReply }) => {
    await withCutFixture(async (fixture) => {
      observeNativeGrants(() => {});
      const client = await nativeBindingClient.attachNativeBindingDeletionClient(
        fixture.bindingStore,
        fixture.bindingKey,
      );
      const arrived = createDeferred();
      const release = createDeferred();
      const published = vi.fn();
      const unsubscribe = onSessionIdentityMutation((change) => {
        if (change.previous.sessionKeys.includes(fixture.scope.sessionKey)) {
          published(change);
        }
      });
      delivery.afterExecution = async () => {
        arrived.resolve();
        await release.promise;
        if (loseReply) {
          throw new Error("synthetic C3 result delivery lost");
        }
      };
      const cut = fixture.cut(mode, entryId);
      try {
        await awaitGateBeforeSettlement(arrived.promise, cut, "C3 did not reach receipt delivery");
        expect(fixture.readEntry()?.sessionId).not.toBe(fixture.scope.sessionId);
        expect(fixture.readBinding()).toBeUndefined();
        expect(published).not.toHaveBeenCalled();
        expect(client.release).not.toHaveBeenCalled();
        expect(client.request).not.toHaveBeenCalled();
        expect(client.subscribed()).toBe(true);
        release.resolve();
        const result = await cut;
        expect(result.status).toBe("created");
        assert(result.status === "created");
        expect(result.entry.previousSessionId).toBe(fixture.scope.sessionId);
        expect(
          loadTranscriptEventsSync({ ...fixture.scope, sessionId: result.entry.sessionId }).at(-1),
        ).toMatchObject({ type: "leaf", targetId: leafId });
        expectOneAcceptedExecution();
        expect(published).toHaveBeenCalledOnce();
        expect(client.release).toHaveBeenCalledOnce();
        expect(client.request).toHaveBeenCalledOnce();
        expect(client.subscribed()).toBe(false);
      } finally {
        release.resolve();
        await cut.catch(() => {});
        unsubscribe();
        client.close();
      }
    });
  },
);
