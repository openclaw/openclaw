import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as personalAccountAuth from "../plugins/personal-account-auth.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("settles an accepted personal account write across the real close prelude", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-personal-account-close", signal);
  const { fixture, kernel } = race;
  let providerSignal: AbortSignal | undefined;
  const method = vi
    .spyOn(personalAccountAuth, "resolvePersonalAccountAuthMethod")
    .mockResolvedValue({
      id: "api-key",
      label: "Synthetic sign-in",
      kind: "api_key",
      run: async (context) => {
        providerSignal = context.signal;
        return {
          profiles: [
            {
              profileId: "ignored",
              credential: {
                type: "api_key",
                provider: "example",
                key: "synthetic-close-key",
              },
            },
          ],
        };
      },
    });
  race.onCleanup(() => method.mockRestore());
  try {
    const service = expectDefined(
      kernel.gatewayRequestContext.modelAccountConnectService,
      "Account service",
    );
    const owner = ensureProfileForEmail("account-close@example.test", { env: fixture.state.env });
    const action = { owner: owner.id, assertCurrent() {} };
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const worker = probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (command.type === "userProfiles.modelAccount.connect") {
        await race.block();
      }
      return scope.execute(command, executeOptions);
    });
    race.onCleanup(() => worker.mockRestore());
    // The Wizard outlives its initiating request but inherits that request's work scope.
    await kernel.gatewayRequestContext.trackExecution(() =>
      service.start(action, "example", "api-key"),
    );
    await race.waitForEntry();
    await race.close();
    expect(providerSignal?.aborted).toBe(true);
    await expect(service.start(action, "example", "api-key")).rejects.toThrow(
      "current authorized connection",
    );
    expect(race.closed).toBe(false);
    expect(shared.isOpen).toBe(true);
    await race.finish();
    expect(shared.isOpen).toBe(false);
    expect(
      readClosedDatabase(
        resolveOpenClawStateSqlitePath(fixture.state.env),
        `
            SELECT COUNT(*) AS linked
            FROM secret_store_entries AS links
            JOIN secret_store_entries AS account
              ON account.scope_kind = links.scope_kind AND account.scope_id = links.scope_id
              AND account.name = 'model-account:' || json_extract(links.value, '$.links.example.authProfileId')
            WHERE links.scope_kind = 'identity' AND links.scope_id = ?
              AND links.name = 'model-accounts'
              AND links.deleted_at_ms IS NULL AND account.deleted_at_ms IS NULL
              AND json_extract(account.value, '$.credential.provider') = 'example'
          `,
        owner.id,
      ),
    ).toEqual([{ linked: 1 }]);
  } finally {
    await race.dispose();
  }
});
