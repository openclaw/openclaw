import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import {
  creationIntent,
  expectEmptyCreation,
  operationFixture,
  operationRequest,
  successfulCreation,
} from "./server.sessions.create.operations.test-support.js";
import { setupSessionCreateHandlerTestHarness } from "./server.sessions.create.test-support.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";
import * as creationService from "./session-create-service.js";

const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness();
const thirtyDays = 30 * 24 * 60 * 60 * 1000;

// This is RPC/storage composition proof. The original transport-only restart
// failure is preserved in .openclaw/tmp/replay-baseline-clean.log; unsupported
// durable fields on the base alone are not the lost-response regression proof.
test("reconciles a lost create reply after database workers and RPC state reopen", async () => {
  const f = await operationFixture(createSessionStoreDir);
  const params = { ...creationIntent(), label: "Original intent", idempotencyKey: "lost-reply" };
  const created = successfulCreation(
    await operationRequest(f.context, f.client, "sessions.create", params),
  );
  const key = "agent:main:dashboard:" + params.sessionId;
  expect(created).toMatchObject({
    key,
    sessionId: params.sessionId,
    creationOperationId: params.creationOperationId,
    creationReplayed: false,
    runStarted: false,
  });
  expect(created).not.toHaveProperty("runId");
  await expectEmptyCreation(f.storePath, key, params.sessionId);

  // Mutable presentation is not creation intent. A cached old ACK would return
  // the original label; rerunning creation would overwrite the accepted rename.
  const patched = await operationRequest(f.context, f.client, "sessions.patch", {
    key,
    label: "Renamed after creation",
  });
  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  const reopened = await f.reopen();
  const retryClient = identifiedClient(f.owner.id);
  const replayed = successfulCreation(
    await operationRequest(reopened, retryClient, "sessions.create", params),
  );
  expect(replayed).toMatchObject({
    key,
    sessionId: params.sessionId,
    creationReplayed: true,
    runStarted: false,
    entry: { label: "Renamed after creation" },
  });
  // Transport keys are deliberately not part of immutable creation intent.
  const changedTransport = successfulCreation(
    await operationRequest(reopened, retryClient, "sessions.create", {
      ...params,
      idempotencyKey: "new-connection-key",
    }),
  );
  expect(changedTransport).toMatchObject({
    key,
    sessionId: params.sessionId,
    creationReplayed: true,
  });
  await expectEmptyCreation(f.storePath, key, params.sessionId);
});

test("concurrent duplicate RPCs commit one physical session and one empty transcript", async () => {
  const f = await operationFixture(createSessionStoreDir);
  const params = creationIntent(Date.now(), 2, "-");
  const second = await f.makeContext();
  const replies = await Promise.all([
    operationRequest(f.context, f.client, "sessions.create", params),
    operationRequest(second, identifiedClient(f.owner.id), "sessions.create", params),
  ]);
  const created = replies.map(successfulCreation);
  expect(created.map((reply) => reply.sessionId)).toEqual([params.sessionId, params.sessionId]);
  expect(new Set(created.map((reply) => reply.creationReplayed))).toEqual(new Set([false, true]));
  expect(new Set(created.map((reply) => reply.key)).size).toBe(1);
  await expectEmptyCreation(f.storePath, created[0]!.key, params.sessionId);
});

test("binds intent, principal and physical UUID instead of adopting an existing target", async () => {
  const f = await operationFixture(createSessionStoreDir);
  const now = Date.now();
  const params = { ...creationIntent(now, 3), label: "Bound intent" };
  const created = successfulCreation(
    await operationRequest(f.context, f.client, "sessions.create", params),
  );
  const otherClient = identifiedClient(ensureProfileForEmail("other-creator@example.invalid").id);
  const otherPhysical = creationIntent(now, 4).sessionId;
  for (const [client, changed] of [
    [f.client, { ...params, label: "Different intent" }],
    [f.client, { ...params, sessionId: otherPhysical }],
    [otherClient, params],
    [f.client, { ...params, creationOperationId: creationIntent(now, 5).creationOperationId }],
  ] as const) {
    const refused = await operationRequest(f.context, client, "sessions.create", changed);
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "creation-operation-conflict" } },
    });
    expect(refused.payload).toBeUndefined();
  }
  expect(
    loadSessionEntry({
      sessionKey: "agent:main:dashboard:" + otherPhysical,
      storePath: f.storePath,
    }),
  ).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: created.key, storePath: f.storePath })).toMatchObject({
    sessionId: params.sessionId,
    label: "Bound intent",
    createdActor: { type: "human", id: f.owner.id },
  });
  await expectEmptyCreation(f.storePath, created.key, params.sessionId);
});

test.each(["sessions.delete", "sessions.reset"] as const)(
  "%s makes both warm transport and reopened durable retries refuse revival",
  async (method) => {
    const f = await operationFixture(createSessionStoreDir, undefined, true);
    const params = { ...creationIntent(), idempotencyKey: "never-revive" };
    const created = successfulCreation(
      await operationRequest(f.context, f.client, "sessions.create", params),
    );
    const before = expectDefined(
      loadSessionEntry({ sessionKey: created.key, storePath: f.storePath }),
      "created row",
    );
    const changed = await operationRequest(f.context, f.client, method, { key: created.key });
    expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
    const after = loadSessionEntry({ sessionKey: created.key, storePath: f.storePath });
    if (method === "sessions.delete") {
      expect(after).toBeUndefined();
    } else {
      // Reset currently retains the physical ID and advances lifecycleRevision.
      // Matching only sessionId would incorrectly replay this retired incarnation.
      expect(after?.sessionId).toBe(params.sessionId);
      expect(after?.lifecycleRevision).not.toBe(before.lifecycleRevision);
    }
    const expectUnavailable = async (context: typeof f.context, client = f.client) => {
      const retry = await operationRequest(context, client, "sessions.create", params);
      expect(retry).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", details: { reason: "creation-session-unavailable" } },
      });
      expect(loadSessionEntry({ sessionKey: created.key, storePath: f.storePath })).toEqual(after);
    };
    await expectUnavailable(f.context);
    await expectUnavailable(await f.reopen(), identifiedClient(f.owner.id));
  },
);

test("enforces the thirty-day lease on warm replays and rejects future or differently issued UUIDs", async () => {
  const f = await operationFixture(createSessionStoreDir);
  const now = Date.now();
  // Real time in database workers remains valid; only the RPC clock advances.
  // A cached transport reply would incorrectly succeed at the exact expiry.
  const issuedAt = now - thirtyDays + 60_000;
  const params = { ...creationIntent(issuedAt), idempotencyKey: "lease-boundary" };
  const created = successfulCreation(
    await operationRequest(f.context, f.client, "sessions.create", params),
  );
  using clock = vi.spyOn(Date, "now").mockReturnValue(issuedAt + thirtyDays);
  const expired = await operationRequest(f.context, f.client, "sessions.create", params);
  expect(expired).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", details: { reason: "creation-operation-expired" } },
  });
  clock.mockReturnValue(now);
  const future = creationIntent(now + 60_001, 6);
  const mismatchedTime = {
    ...creationIntent(now, 7),
    sessionId: creationIntent(now - 1, 7).sessionId,
  };
  for (const invalid of [future, mismatchedTime]) {
    expect(await operationRequest(f.context, f.client, "sessions.create", invalid)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "creation-operation-invalid" } },
    });
    expect(
      loadSessionEntry({
        sessionKey: "agent:main:dashboard:" + invalid.sessionId,
        storePath: f.storePath,
      }),
    ).toBeUndefined();
  }
  await expectEmptyCreation(f.storePath, created.key, params.sessionId);
});

test("requires canonical explicit binding and never retargets when the creation default changes", async () => {
  const f = await operationFixture(createSessionStoreDir);
  const params = creationIntent();
  const { agentId: _agentId, ...implicit } = params;
  for (const invalid of [implicit, { ...params, agentId: " MAIN " }]) {
    expect(await operationRequest(f.context, f.client, "sessions.create", invalid)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  }
  const config = f.getConfig();
  f.setConfig({
    ...config,
    agents: { ...config.agents, defaults: { ...config.agents?.defaults, systemAgent: undefined } },
  });
  // A separate system-agent selection is not a prerequisite for this API.
  // The existing fixed-store creation owner still resolves to main.
  const created = successfulCreation(
    await operationRequest(f.context, f.client, "sessions.create", params),
  );
  f.setConfig(config);
  // A changed configured default cannot silently retarget the same operation.
  f.setConfig({
    ...config,
    agents: {
      ...config.agents,
      entries: { main: {}, work: {} },
      defaults: { ...config.agents?.defaults, sessionStore: { agentId: "work" } },
    },
  });
  expect(await operationRequest(f.context, f.client, "sessions.create", params)).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST" },
  });
  f.setConfig(config);
  await expectEmptyCreation(f.storePath, created.key, params.sessionId);
});

test("requires a verified profile and write authority, and accepts no initial task or message", async () => {
  const f = await operationFixture(createSessionStoreDir);
  const params = creationIntent();
  const readOnly = identifiedClient(f.owner.id);
  readOnly.connect.scopes = ["operator.read"];
  const denied = await operationRequest(f.context, readOnly, "sessions.create", params);
  expect(denied).toMatchObject({ ok: false, error: { message: expect.stringMatching(/scope/i) } });
  const unverified = {
    connect: gatewayConnect(["operator.read", "operator.write"]),
    authenticatedUserId: "unverified@example.invalid",
  };
  // Disable role selection only for this control: otherwise a missing profile
  // can fail the role gate before reaching durable creation's identity contract.
  const config = f.getConfig();
  f.setConfig({ ...config, gateway: { ...config.gateway, roles: undefined } });
  expect(await operationRequest(f.context, unverified, "sessions.create", params)).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringMatching(/verified profile/i) },
  });
  f.setConfig(config);
  for (const extra of [{ message: "Run now" }, { task: "Run now" }, { message: "" }]) {
    expect(
      await operationRequest(f.context, f.client, "sessions.create", { ...params, ...extra }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  }
  expect(
    loadSessionEntry({
      sessionKey: "agent:main:dashboard:" + params.sessionId,
      storePath: f.storePath,
    }),
  ).toBeUndefined();
  const created = successfulCreation(
    await operationRequest(f.context, f.client, "sessions.create", params),
  );
  expect(created.runStarted).toBe(false);
  await expectEmptyCreation(f.storePath, created.key, params.sessionId);
});

test("refuses replay disclosure when the caller changes after service reconciliation", async () => {
  const f = await operationFixture(createSessionStoreDir);
  const params = creationIntent();
  const created = successfulCreation(
    await operationRequest(f.context, f.client, "sessions.create", params),
  );
  const different = ensureProfileForEmail("replacement-creator@example.invalid");
  const create = creationService.createGatewaySession;
  using afterReconciliation = vi
    .spyOn(creationService, "createGatewaySession")
    .mockImplementationOnce(async (...args) => {
      const result = await create(...args);
      f.client.authenticatedUserProfile = identifiedClient(different.id).authenticatedUserProfile;
      return result;
    });
  const replay = await operationRequest(f.context, f.client, "sessions.create", params);
  expect(afterReconciliation).toHaveBeenCalledOnce();
  expect(replay.ok).toBe(false);
  expect(replay.payload).toBeUndefined();
  await expectEmptyCreation(f.storePath, created.key, params.sessionId);
});
