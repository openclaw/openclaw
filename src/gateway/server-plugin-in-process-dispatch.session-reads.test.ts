import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as sqliteQueries from "../infra/kysely-sync.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  dispatchGatewayMethodInProcessRaw,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const sessionKey = "agent:main:foreign";
const methods = ["sessions.list", "sessions.describe"] as const;
type ReadMethod = (typeof methods)[number];

async function withSyntheticReader(
  run: (fixture: {
    readerId: string;
    ownerEmail: string;
    dispatch: (method: ReadMethod) => ReturnType<typeof dispatchGatewayMethodInProcessRaw>;
    blockCatalog: () => { entered: Promise<void>; readEntered: Promise<void>; release: () => void };
  }) => Promise<void>,
  visibility: "shared" | "draft" = "shared",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
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
              authenticatedUserProfile: {
                profileId: reader.id,
                displayName: "Synthetic reader",
                hasAvatar: false,
                updatedAt: 1,
              },
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
          const ensure = projection.ensureMaterialized.bind(projection);
          // Background catalog work uses a private closure; this observes the actual reader.
          const readiness = vi
            .spyOn(projection, "ensureMaterialized")
            .mockImplementationOnce(() => {
              readEntered.resolve();
              return ensure();
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
      try {
        // Dispatch reports handler errors through its response; join the owned work before disposal.
        await Promise.allSettled(executions);
        await projection.ensureMaterialized();
      } finally {
        restoreReadiness?.();
        projection.dispose();
      }
    }
  });
}

function expectVisible(
  method: ReadMethod,
  result: Awaited<ReturnType<typeof dispatchGatewayMethodInProcessRaw>>,
  sharingRole: "viewer" | "owner",
) {
  expect(result).toMatchObject({
    ok: true,
    payload:
      method === "sessions.list"
        ? { sessions: [{ key: sessionKey, sessionId: "synthetic-session", sharingRole }] }
        : { session: { key: sessionKey, sessionId: "synthetic-session", sharingRole } },
  });
}

describe("synthetic plugin session reads", () => {
  it.each(methods)(
    "preserves a non-admin operator's foreign-session grant on %s",
    async (method) => {
      await withSyntheticReader(async ({ dispatch }) => {
        expectVisible(method, await dispatch(method), "viewer");
        const native = vi.spyOn(openOpenClawStateDatabase().db, "prepare");
        const reads = [
          "executeSqliteQuerySync",
          "executeSqliteQueryTakeFirstSync",
          "iterateSqliteQuerySync",
        ] as const;
        const spies = reads.map((name) => vi.spyOn(sqliteQueries, name));
        try {
          expectVisible(method, await dispatch(method), "viewer");
          expect(native).not.toHaveBeenCalled();
          for (const spy of spies) {
            expect(spy).not.toHaveBeenCalled();
          }
        } finally {
          native.mockRestore();
          spies.forEach((spy) => spy.mockRestore());
        }
      });
    },
  );

  it.each(methods)("recognizes merged-profile ownership on %s", async (method) => {
    await withSyntheticReader(async ({ readerId, ownerEmail, dispatch }) => {
      setUserProfileRole(readerId, "blocked");
      linkEmail(ownerEmail, readerId);
      expectVisible(method, await dispatch(method), "owner");
    }, "draft");
  });

  it.each(methods)("honors role revocation during projection readiness on %s", async (method) => {
    await withSyntheticReader(async ({ readerId, dispatch, blockCatalog }) => {
      const gate = blockCatalog();
      const pending =
        method === "sessions.list" ? Promise.allSettled([dispatch(method)]) : undefined;
      try {
        await gate.entered;
        if (pending) {
          await gate.readEntered;
        }
        setUserProfileRole(readerId, "blocked");
        if (pending) {
          gate.release();
          expect(await pending).toEqual([
            {
              status: "rejected",
              reason: expect.objectContaining({
                message: "Your operator role changed; reconnect before continuing.",
              }),
            },
          ]);
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
    });
  });
});
