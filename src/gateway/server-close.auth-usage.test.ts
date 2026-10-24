import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { markAuthProfileSuccess } from "../agents/auth-profiles/profiles.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { markAuthProfileFailure } from "../agents/auth-profiles/usage.js";
import { markEmbeddedRunAuthProfileSuccess } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as personalAccountAuth from "../plugins/personal-account-auth.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDatabaseLifecycle from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import * as userProfiles from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { readMentionStoreSnapshot } from "./mention-inbox-store.worker.js";
import type { MentionCommittedInput } from "./mention-inbox.types.js";
import { createTestGate, readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

async function closeRace(label: string, signal: AbortSignal) {
  const race = await createGatewayCloseRace(label, signal);
  return Object.assign(race, { [Symbol.asyncDispose]: () => race.dispose() });
}

it("settles accepted auth bookkeeping across the close prelude and refuses new usage", async ({
  signal,
}) => {
  await using race = await closeRace("gateway-auth-usage-close", signal);
  const { fixture, kernel } = race;
  let queuedFailure: Promise<void> | undefined = undefined;
  race.onCleanup(() => queuedFailure?.catch(() => {}));
  const profileId = "fixture:accepted-close";
  const store: AuthProfileStore = {
    version: 1,
    profiles: { [profileId]: { type: "token", provider: "fixture", token: "synthetic-token" } },
    usageStats: { [profileId]: { errorCount: 3, cooldownUntil: Date.now() + 60_000 } },
  };
  saveAuthProfileStore(store, undefined, { syncExternalCli: false });
  const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
  const recording = probe.command(stateWorker, async (command, executeOptions, scope) => {
    if (command.type === "authProfiles.usage") {
      await race.block();
    }
    return scope.execute(command, executeOptions);
  });
  race.onCleanup(() => recording.mockRestore());
  const inGateway = <T>(operation: () => T) =>
    withPluginRuntimeGatewayContextResolver(kernel.resolvePluginGatewayContext, operation);
  inGateway(() =>
    markEmbeddedRunAuthProfileSuccess({
      profileId,
      profileStore: store,
      provider: "fixture",
      runId: "accepted-close-run",
      sessionId: "accepted-close-session",
    }),
  );
  await race.waitForEntry();
  queuedFailure = inGateway(() => markAuthProfileFailure({ store, profileId, reason: "timeout" }));
  void queuedFailure.catch(() => undefined);
  await race.close(kernel.scheduler.signal, undefined, { reason: "auth usage close" });
  await expect(
    inGateway(() => markAuthProfileSuccess({ store, profileId, provider: "fixture" })),
  ).rejects.toThrow("Auth profile usage owner is closed");
  expect(race.closed).toBe(false);
  expect(shared.isOpen).toBe(true);

  await race.finish();
  await queuedFailure;
  expect(shared.isOpen).toBe(false);
  const [row] = readClosedDatabase(
    resolveOpenClawStateSqlitePath(fixture.state.env),
    "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.state'",
  );
  expect(JSON.parse(String(row?.value_json))).toMatchObject({
    lastGood: { fixture: profileId },
    usageStats: {
      [profileId]: {
        lastUsed: expect.any(Number),
        errorCount: 1,
        failureCounts: { timeout: 1 },
      },
    },
  });
});

it("settles an accepted personal account write across the real close prelude", async ({
  signal,
}) => {
  await using race = await closeRace("gateway-personal-account-close", signal);
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
});

it("persists accepted mentions before Gateway close resolves", async ({ signal }) => {
  await using race = await closeRace("gateway-mention-close", signal);
  const { fixture, kernel } = race;
  const gate = createTestGate(signal);
  const joining = new AbortController();
  const databasesClosing = createDeferredCore();
  let acceptedSettled = false;
  let accepted: Promise<void> | undefined = undefined;
  race.onCleanup(async () => {
    await Promise.allSettled([accepted]);
    vi.restoreAllMocks();
  });
  const closeDatabases = agentDatabaseLifecycle.closeOpenClawAgentDatabasesAsync;
  vi.spyOn(agentDatabaseLifecycle, "closeOpenClawAgentDatabasesAsync").mockImplementation(
    (...args) => {
      databasesClosing.resolve();
      return closeDatabases(...args);
    },
  );
  const dispose = kernel.mentionInbox.dispose;
  let fenced = false;
  vi.spyOn(kernel.mentionInbox, "dispose").mockImplementation(() => {
    const pending = dispose();
    // The prelude fences first; observe the later join without settling its work.
    if (fenced) {
      joining.abort();
    }
    fenced = true;
    return pending;
  });
  const alice = ensureProfileForEmail("alice@mentions.example.test");
  const bob = ensureProfileForEmail("bob@mentions.example.test");
  const sessionKey = "agent:main:mention-close";
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: "mention-close-session",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: alice.id },
    },
  );
  await kernel.mentionInbox.invalidateAsync();
  const input: MentionCommittedInput = {
    sourceId: "accepted-before-close",
    committedSource: { generation: "mention-close", sequence: 1, timestamp: 1 },
    sessionKey,
    agentId: "main",
    sessionId: "mention-close-session",
    messageId: "accepted-before-close",
    senderProfileId: alice.id,
    recipientProfileIds: [bob.id],
    excerpt: "@Bob review this change",
  };
  const prepareProfiles = userProfiles.prepareUserProfileCatalog;
  vi.spyOn(userProfiles, "prepareUserProfileCatalog").mockImplementationOnce(async (...args) => {
    const profiles = await prepareProfiles(...args);
    await race.block();
    return profiles;
  });
  accepted = kernel.mentionInbox.recordCommittedInputAsync(input).then(() => {
    acceptedSettled = true;
  });
  await race.waitForEntry(accepted, "Mention bypassed profile alias preparation");
  const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
  const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env }).db;
  await gate(
    race.close(joining.signal, undefined, { reason: "mention close regression" }),
    databasesClosing.promise,
    "Gateway began database close before joining accepted mention persistence",
  );
  await kernel.mentionInbox.recordCommittedInputAsync({
    ...input,
    sourceId: "refused-after-close",
    messageId: "refused-after-close",
  });
  expect([acceptedSettled, shared.isOpen, agent.isOpen]).toEqual([false, true, true]);
  await race.finish(accepted);
  expect([acceptedSettled, shared.isOpen, agent.isOpen]).toEqual([true, false, false]);

  const stored = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => readMentionStoreSnapshot(-1, db),
    { env: fixture.state.env },
  );
  expect(stored?.sources.map((source) => source.message?.content.messageId)).toEqual([
    "accepted-before-close",
  ]);
  expect(stored?.sources[0]?.recipients).toEqual([[bob.id, expect.any(String)]]);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey })?.profileInvolvement?.profiles[bob.id],
  ).toMatchObject({ hidden: false, lastMention: input.committedSource });
});
