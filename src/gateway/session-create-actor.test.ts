import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

it("creates explicit private keys through the canonical owner and refuses a retired source", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const authority = { assertCurrent() {} };
    const actor = await openIncognitoTestActor(env, authority);
    const key = "agent:main:dashboard:incognito-local-create";
    const params = {
      cfg: {},
      key,
      incognito: true,
      commandSource: "cli",
      operatorRoleActor: { kind: "system" as const },
      requestingOperatorScopes: ["operator.admin"],
    };
    const sql = observeHostDataSql();
    try {
      const created = await withIncognitoSessionActor(actor, () => createGatewaySession(params));
      expect(created).toMatchObject({ ok: true, key, entry: { incognito: true } });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      expect((await actor.sessions.read(authority, { sessionKey: key })).entry?.sessionId).toBe(
        created.entry.sessionId,
      );
      await expect(
        withIncognitoSessionActor(actor, () => createGatewaySession(params)),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: "incognito is immutable and requires a new session key" },
      });

      const entered = createDeferredCore();
      const release = createDeferredCore();
      const pendingKey = "agent:main:dashboard:incognito-local-retired";
      const pending = withIncognitoSessionActor(actor, () =>
        createGatewaySession({
          ...params,
          key: pendingKey,
          prepareLifecycle: async () => {
            entered.resolve();
            await release.promise;
            return { ok: true, value: {} };
          },
        }),
      );
      await entered.promise;
      const refused = expect(pending).rejects.toThrow(/ended|current/u);
      const closing = actor.close();
      release.resolve();
      await refused;
      await closing;
      const successor = await openIncognitoTestActor(env, authority);
      try {
        expect(
          (await successor.sessions.read(authority, { sessionKey: pendingKey })).entry,
        ).toBeUndefined();
      } finally {
        await successor.close();
      }
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      await actor.close();
    }
  });
});
