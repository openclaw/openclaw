import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { PluginStateStoreError } from "../../plugin-state/plugin-state-store.types.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import * as execution from "../../state/openclaw-agent-execution.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as native from "./session-native-binding.execution.test-support.js";
import {
  withNativeBindingFixture,
  type NativeBindingClientTestApi,
} from "./session-native-binding.test-support.js";
import { messageEvent } from "./transcript-message.test-support.js";

// Load the plugin graph during collection; each fixture still owns its storage and runtime.
const { attachNativeBindingDeletionClient: attachClient } =
  await loadBundledPluginFacade<NativeBindingClientTestApi>({
    pluginId: "codex",
    artifactBasename: "native-session-binding.test-api.js",
  });

afterEach(() => vi.restoreAllMocks());
const userId = "synthetic-user";
const activeId = "synthetic-active";
const alternateId = "synthetic-alternate";
const visibleId = "synthetic-visible";
const unknownOutcome = { code: "outcome-unknown" };

type Fixture = Parameters<Parameters<typeof withNativeBindingFixture>[1]>[0];
type Observe = Parameters<typeof native.observeNativeGrants>[1];

function createCutFixture(fixture: Fixture) {
  let observe: Observe = () => {};
  let accepted = 0;
  const answer = (id: string, content: string, timestamp: number) =>
    messageEvent(id, userId, { role: "assistant", content, timestamp });
  replaceTranscriptEventsSync(fixture.scope, [
    ...fixture.events,
    answer(activeId, "Active answer", 2),
    answer(alternateId, "Alternate answer", 3),
    { type: "leaf", id: visibleId, parentId: alternateId, targetId: activeId },
  ]);
  const snapshot = () => [fixture.readEntry(), loadTranscriptEventsSync(fixture.scope)];
  const original = snapshot();
  probe.admission(admission, (request, grant, admit) => {
    const facts = native.publication(request);
    if (facts?.kind === "native-binding-ready") {
      // Ready-grant hooks run after renewal has quiesced, not at admission.
      admit(request, () => {
        observe(request, facts);
        const granted = grant();
        if (granted) {
          accepted++;
        }
        return granted;
      });
    } else {
      if (facts) {
        observe(request, facts);
      }
      admit(request, grant);
    }
  });
  return {
    ...fixture,
    accepted: () => accepted,
    onGrant: (next: Observe) => {
      observe = next;
    },
    expectUnchanged: () => expect(snapshot()).toEqual(original),
    attachClient: () => attachClient(fixture.bindingStore, fixture.bindingKey),
  };
}

const withCutFixture = (run: (fixture: ReturnType<typeof createCutFixture>) => Promise<void>) =>
  withNativeBindingFixture("codex", (fixture) => run(createCutFixture(fixture)));

it("vetoes rewind before A COMMIT when the native binding delete fails", () =>
  withCutFixture(async (fixture) => {
    let prepared = false;
    fixture.onGrant((_request, facts) => {
      if (facts.kind === "native-binding-ready" && !prepared) {
        prepared = true;
        fixture.shared.db
          .prepare(
            "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND entry_key = ?",
          )
          .run("{ corrupt synthetic binding", "codex", fixture.bindingKey);
      }
    });
    const failure = await fixture.cut("rewind", userId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginStateStoreError);
    expect(failure).toMatchObject({ operation: "delete", code: "PLUGIN_STATE_CORRUPT" });
    fixture.expectUnchanged();
  }));

it("leaves a successor binding intact when rewind compensation cannot restore its predecessor", () =>
  withCutFixture(async (fixture) => {
    const successor = {
      version: 1,
      state: "active",
      sessionId: "successor-generation",
      binding: { threadId: "successor-thread", cwd: "/synthetic/successor" },
    };
    fixture.onGrant((request, facts) => {
      if (request.stage === "commit" && facts.kind === "session-native-binding") {
        expect(fixture.readBinding()).toBeUndefined();
        fixture.bindingStore.register(fixture.bindingKey, successor);
        throw new Error("synthetic rewind COMMIT refusal");
      }
    });
    await expect(fixture.cut("rewind", userId)).rejects.toMatchObject(unknownOutcome);
    fixture.expectUnchanged();
    expect(fixture.readBinding()).toEqual(successor);
    await expect(fixture.cut("rewind", userId)).rejects.toMatchObject(unknownOutcome);
    expect(fixture.accepted()).toBe(1);
    expect(fixture.readBinding()).toEqual(successor);
  }));

it("blocks branch switching after actual worker loss without releasing native subscription custody", () =>
  withCutFixture(async (fixture) => {
    const client = await fixture.attachClient();
    const terminateWorker = native.captureCommandWorker("session.messageCut.commit");
    let stopped: Promise<number> | undefined;
    fixture.onGrant((request, facts) => {
      if (request.stage === "commit" && facts.kind === "session-native-binding" && !stopped) {
        stopped = terminateWorker();
        throw new Error("synthetic branch worker termination");
      }
    });
    try {
      const cut = fixture.cut("switch", alternateId);
      await expect(cut).rejects.toBeInstanceOf(SqliteWorkerError);
      await expect(cut).rejects.toMatchObject(unknownOutcome);
      assert(stopped);
      await stopped;
      fixture.expectUnchanged();
      expect(fixture.readBinding()).toBeUndefined();
      await expect(fixture.cut("switch", alternateId)).rejects.toMatchObject(unknownOutcome);
      expect(fixture.accepted()).toBe(1);
      expect(client.release).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
      expect(client.subscribed()).toBe(true);
    } finally {
      await stopped;
      client.close();
    }
  }));

it.each([
  { mode: "rewind", entryId: userId, leafId: null, loseReply: false },
  { mode: "switch", entryId: alternateId, leafId: alternateId, loseReply: true },
] as const)(
  "settles $mode identity and subscription only after its delayed receipt (lost reply: $loseReply)",
  ({ mode, entryId, leafId, loseReply }) =>
    withCutFixture(async (fixture) => {
      const client = await fixture.attachClient();
      const arrived = createDeferred();
      const release = createDeferred();
      const published = vi.fn();
      const unsubscribe = onSessionIdentityMutation((change) => {
        if (change.previous.sessionKeys.includes(fixture.scope.sessionKey)) {
          published(change);
        }
      });
      native.spyAgentExecutions(execution, (worker) => ({
        async execute(command, options) {
          const result = await worker.execute(command, options);
          if (command.type === "session.messageCut.commit") {
            arrived.resolve();
            await release.promise;
            if (loseReply) {
              throw new Error("synthetic C3 result delivery lost");
            }
          }
          return result;
        },
      }));
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
        assert(result.status === "created");
        expect(result.entry.previousSessionId).toBe(fixture.scope.sessionId);
        expect(
          loadTranscriptEventsSync({ ...fixture.scope, sessionId: result.entry.sessionId }).at(-1),
        ).toMatchObject({ type: "leaf", targetId: leafId });
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
    }),
);
