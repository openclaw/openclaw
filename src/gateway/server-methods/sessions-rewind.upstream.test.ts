import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  captureSessionUpstreamLinkReadSource,
  prepareSessionUpstreamLink,
} from "../../sessions/session-upstream-links-runtime.js";
import * as upstreamReads from "../../sessions/session-upstream-links-runtime.js";
import { upsertSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  cfg,
  invokeMessageCut,
  readMutationStorage,
  seedMessageCutSource,
  useMessageCutStorageFixture,
  type SourceScope,
} from "./sessions-rewind.storage.test-support.js";

useMessageCutStorageFixture();

function adoptUpstreamSource(scope: SourceScope, threadId = "late-upstream-thread"): boolean {
  return upsertSessionUpstreamLink(
    {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      catalogId: "fixture",
      hostId: "gateway:local",
      threadId,
      upstreamKind: "codex-app-server",
      upstreamRef: { threadId },
      marker: null,
    },
    { now: 1 },
  );
}

it.each(
  (["sessions.fork", "sessions.rewind"] as const).flatMap((method) =>
    (["transaction", "commit"] as const).map((boundary) => ({ method, boundary })),
  ),
)(
  "refuses $method when an upstream link appears at the $boundary boundary",
  async ({ method, boundary }) => {
    await withOpenClawTestState({ label: "message-cut-upstream-commit" }, async (testState) => {
      await testState.writeConfig(cfg);
      const scope = await seedMessageCutSource();
      const before = await readMutationStorage(scope);
      openOpenClawStateDatabase();
      const create = workerAdmission.createSqliteWorkerOperationAdmission;
      let linked = false;
      let stage: workerAdmission.SqliteWorkerAdmissionRequest["stage"] | "outside" = "outside";
      const guardCalls = { outside: 0, open: 0, prepare: 0, transaction: 0, commit: 0 };
      vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            if (
              !linked &&
              request.stage === boundary &&
              isRecord(request.facts) &&
              (boundary === "transaction"
                ? request.facts.publication === undefined
                : isRecord(request.facts.publication) &&
                  request.facts.publication.kind === "session-entry-patch-committed")
            ) {
              linked = adoptUpstreamSource(scope);
            }
            const previousStage = stage;
            stage = request.stage;
            try {
              callback(request, grant);
            } finally {
              stage = previousStage;
            }
          }, attachment),
      );
      const mutation = invokeMessageCut(method, scope, {
        sessionMutationCommitGuard: () => {
          guardCalls[stage] += 1;
        },
      });
      await mutation.error;

      expect(linked).toBe(true);
      const diagnostic = JSON.stringify({ method, guardCalls });
      expect.soft(await readMutationStorage(scope), diagnostic).toEqual(before);
      expect(mutation.respond, diagnostic).not.toHaveBeenCalledWith(
        true,
        expect.anything(),
        undefined,
      );
    });
  },
);

it.each(["preparation", "current guard"] as const)(
  "refuses a local cut when upstream %s is unavailable",
  async (phase) => {
    await withOpenClawTestState({ label: "message-cut-upstream-unavailable" }, async (state) => {
      await state.writeConfig(cfg);
      const scope = await seedMessageCutSource();
      const before = await readMutationStorage(scope);
      const prepare = upstreamReads.prepareSessionUpstreamPresence;
      vi.spyOn(upstreamReads, "prepareSessionUpstreamPresence").mockImplementationOnce(
        async (...args) => {
          if (phase === "preparation") {
            throw new Error("fixture upstream read unavailable");
          }
          const prepared = await prepare(...args);
          return {
            ...prepared,
            current() {
              throw new Error("fixture upstream facts unavailable");
            },
          };
        },
      );
      const mutation = invokeMessageCut("sessions.rewind", scope);
      expect(await mutation.error).toBeUndefined();
      expect(await readMutationStorage(scope)).toEqual(before);
      expect(mutation.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
        }),
      );
    });
  },
);

it("refuses incognito native context effects after upstream revocation during preparation", async () => {
  await withOpenClawTestState({ label: "message-cut-native-upstream" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource(true);
    const before = await readMutationStorage(scope);
    openOpenClawStateDatabase();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let bindingPresent = true;
    let linked = false;
    const effect = vi.fn();
    const rollback = vi.fn();
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "native-upstream-fixture" });
    registry.plugins.push(record);
    registry.agentHarnesses.push({
      pluginId: record.id,
      source: "runtime",
      harness: {
        id: "native-upstream-fixture",
        label: "Native source fixture",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("not used");
        },
        withSessionContextReset: async (params, run) => {
          entered.resolve();
          await release.promise;
          params.assertCurrent();
          effect();
          return run({
            commit() {
              params.assertCurrent();
              bindingPresent = false;
              effect();
            },
            rollback() {
              params.assertCurrent();
              bindingPresent = true;
              rollback();
            },
          });
        },
      },
    });
    setActivePluginRegistry(registry);
    const mutation = invokeMessageCut("sessions.rewind", scope);
    try {
      await awaitGateBeforeSettlement(entered.promise, mutation.error, "native reset preparation");
      linked = adoptUpstreamSource(scope);
    } finally {
      release.resolve();
    }
    expect(await mutation.error).toBeUndefined();
    expect(linked).toBe(true);
    expect(
      await prepareSessionUpstreamLink(
        captureSessionUpstreamLinkReadSource(),
        scope.sessionKey,
        scope.agentId,
      ),
    ).toMatchObject({ threadId: "late-upstream-thread" });
    expect(await readMutationStorage(scope)).toEqual(before);
    expect(bindingPresent).toBe(true);
    expect(effect).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(mutation.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("external agent harness"),
      }),
    );
  });
});
it("refuses a shared-state owner retired while rewind waits for the lifecycle lock", async () => {
  await withOpenClawTestState({ label: "message-cut-upstream-retirement" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource();
    const before = await readMutationStorage(scope);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const holding = runExclusiveSessionLifecycleMutation("archive", {
      scope: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
      identities: [scope.sessionId],
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const mutation = invokeMessageCut("sessions.rewind", scope);
    try {
      await closeOpenClawStateDatabaseAsync();
    } finally {
      release.resolve();
      await holding;
    }
    expect(await mutation.error).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/state database read admission (?:changed|is closed)/),
      }),
    );
    expect(await readMutationStorage(scope)).toEqual(before);
    expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
  });
});
