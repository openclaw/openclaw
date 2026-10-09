import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as personalAccountAuth from "../plugins/personal-account-auth.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles an accepted personal account write across the real close prelude", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-personal-account-close");
  const writeEntered = createDeferred();
  const releaseWrite = createDeferred();
  const preludeEntered = createDeferred();
  let closing: Promise<void> | undefined;
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
  let restoreWorker: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const service = expectDefined(
      kernel.gatewayRequestContext.modelAccountConnectService,
      "Account service",
    );
    const owner = ensureProfileForEmail("account-close@example.test", { env: fixture.state.env });
    const action = { owner: owner.id, assertCurrent() {} };
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const run = stateWorker.runOpenClawStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "userProfiles.modelAccount.connect") {
                  writeEntered.resolve();
                  await releaseWrite.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
      );
    restoreWorker = () => worker.mockRestore();
    // The Wizard outlives its initiating request but inherits that request's work scope.
    await kernel.gatewayRequestContext.trackExecution(() =>
      service.start(action, "example", "api-key"),
    );
    await withinTest(writeEntered.promise, signal);
    kernel.requestEntryLifetime.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    let closed = false;
    closing = server.close({ reason: "gateway restarting", restartExpectedMs: 1_500 }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        preludeEntered.promise,
        closing,
        "Gateway closed before fencing requests",
      ),
      signal,
    );
    expect(providerSignal?.aborted).toBe(true);
    await expect(service.start(action, "example", "api-key")).rejects.toThrow(
      "current authorized connection",
    );
    expect(closed).toBe(false);
    expect(shared.isOpen).toBe(true);
    releaseWrite.resolve();
    await withinTest(closing, signal);
    expect(shared.isOpen).toBe(false);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(`
            SELECT COUNT(*) AS linked
            FROM secret_store_entries AS links
            JOIN secret_store_entries AS account
              ON account.scope_kind = links.scope_kind AND account.scope_id = links.scope_id
              AND account.name = 'model-account:' || json_extract(links.value, '$.links.example.authProfileId')
            WHERE links.scope_kind = 'identity' AND links.scope_id = ?
              AND links.name = 'model-accounts'
              AND links.deleted_at_ms IS NULL AND account.deleted_at_ms IS NULL
              AND json_extract(account.value, '$.credential.provider') = 'example'
          `)
          .get(owner.id),
      ).toEqual({ linked: 1 });
    } finally {
      database.close();
    }
  } finally {
    releaseWrite.resolve();
    await closing?.catch(() => {});
    restoreWorker?.();
    method.mockRestore();
    await fixture.cleanup();
  }
});
