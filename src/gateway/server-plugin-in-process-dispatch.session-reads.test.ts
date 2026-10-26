import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as sqliteQueries from "../infra/kysely-sync.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  dispatchGatewayMethodInProcessRaw,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const sessionKey = "agent:main:foreign";
const methods = ["sessions.list", "sessions.describe"] as const;
type ReadMethod = (typeof methods)[number];
type ReadResult = Awaited<ReturnType<typeof dispatchGatewayMethodInProcessRaw>>;

async function withSyntheticReader(
  run: (fixture: {
    readerId: string;
    ownerEmail: string;
    dispatch: (method: ReadMethod) => Promise<ReadResult>;
    blockCatalog: () => { entered: Promise<void>; readEntered: Promise<void>; release: () => void };
  }) => Promise<void>,
  visibility: "shared" | "draft" = "shared",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        roles: {
          default: "blocked",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
            blocked: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
          },
        },
      },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const reader = ensureProfileForEmail("synthetic-reader@example.test");
    const ownerEmail = "synthetic-owner@example.test";
    const owner = ensureProfileForEmail(ownerEmail);
    setUserProfileRole(reader.id, "reader");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "synthetic-session",
        updatedAt: 1,
        visibility,
        createdActor: { type: "human", source: "profile", id: owner.id },
      },
    );
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      trackExecution: trackAsyncWork,
    });
    const executions: Promise<void>[] = [];
    let catalogGate: ReturnType<typeof createDeferred<void>> | undefined;
    let catalogEntered: ReturnType<typeof createDeferred<void>> | undefined;
    let restoreReadiness: (() => void) | undefined;
    const projection = await createSessionRowProjection({
      cfg: config,
      context,
      getModelCatalog: async () => {
        catalogEntered?.resolve();
        await catalogGate?.promise;
        return undefined;
      },
    });
    bindSessionRowProjection(context, () => projection);
    try {
      await projection.ensureMaterialized();
      await run({
        readerId: reader.id,
        ownerEmail,
        dispatch: (method) =>
          withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: gatewayProfile(reader.id, "Synthetic reader"),
              operatorRoleActor: { kind: "operator", profileId: reader.id },
              scopes: ["operator.read"],
            },
            () =>
              dispatchGatewayMethodInProcessRaw(
                method,
                method === "sessions.list" ? {} : { key: sessionKey },
                {
                  forceSyntheticClient: true,
                  syntheticScopes: ["operator.read"],
                  resolveGatewayContext: () => context,
                  onExecution: (execution) => executions.push(execution),
                },
              ),
          ),
        blockCatalog: () => {
          catalogGate = createDeferred();
          catalogEntered = createDeferred();
          const readEntered = createDeferred();
          const prepare = projection.prepareSelection.bind(projection);
          // Background catalog work uses a private closure; this observes the actual reader.
          const readiness = vi
            .spyOn(projection, "prepareSelection")
            .mockImplementationOnce((...args) => {
              readEntered.resolve();
              return prepare(...args);
            });
          restoreReadiness = () => readiness.mockRestore();
          sessionChanges.emit({ all: true, scope: "catalog" });
          return {
            entered: catalogEntered.promise,
            readEntered: readEntered.promise,
            release: () => catalogGate?.resolve(),
          };
        },
      });
    } finally {
      catalogGate?.resolve();
      // Dispatch reports handler errors through its response; join owned work before disposal.
      await Promise.allSettled(executions);
      try {
        await projection.ensureMaterialized();
      } finally {
        restoreReadiness?.();
        projection.dispose();
      }
    }
  });
}

function expectVisible(method: ReadMethod, result: ReadResult, sharingRole: "viewer" | "owner") {
  expect(result).toMatchObject({
    ok: true,
    payload:
      method === "sessions.list"
        ? { sessions: [{ key: sessionKey, sessionId: "synthetic-session", sharingRole }] }
        : { session: { key: sessionKey, sessionId: "synthetic-session", sharingRole } },
  });
}

it.each(methods)("preserves a non-admin operator's foreign-session grant on %s", (method) =>
  withSyntheticReader(async ({ dispatch }) => {
    expectVisible(method, await dispatch(method), "viewer");
    const spies = [
      vi.spyOn(openOpenClawStateDatabase().db, "prepare"),
      vi.spyOn(sqliteQueries, "executeSqliteQuerySync"),
      vi.spyOn(sqliteQueries, "executeSqliteQueryTakeFirstSync"),
      vi.spyOn(sqliteQueries, "iterateSqliteQuerySync"),
    ];
    try {
      expectVisible(method, await dispatch(method), "viewer");
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  }),
);

it.each(methods)("recognizes merged-profile ownership on %s", (method) =>
  withSyntheticReader(async ({ readerId, ownerEmail, dispatch }) => {
    setUserProfileRole(readerId, "blocked");
    linkEmail(ownerEmail, readerId);
    expectVisible(method, await dispatch(method), "owner");
  }, "draft"),
);

it.each(methods)("honors role revocation during projection readiness on %s", (method) =>
  withSyntheticReader(async ({ readerId, dispatch, blockCatalog }) => {
    const gate = blockCatalog();
    const pending =
      method === "sessions.list" ? dispatch(method).catch((error: unknown) => error) : undefined;
    try {
      await gate.entered;
      if (pending) {
        await gate.readEntered;
      }
      setUserProfileRole(readerId, "blocked");
      if (pending) {
        gate.release();
        expect(await pending).toMatchObject({
          message: "Your operator role changed; reconnect before continuing.",
        });
        expect(await dispatch(method)).toMatchObject({ ok: true, payload: { sessions: [] } });
      } else {
        expect(await dispatch(method)).toMatchObject({
          ok: false,
          error: { message: `Session "${sessionKey}" was not found.` },
        });
      }
    } finally {
      gate.release();
      await pending;
    }
  }),
);
