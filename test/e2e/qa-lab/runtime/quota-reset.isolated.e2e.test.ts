import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { ToolsInvokeResult } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { readPersistedSharedAuthProfileStoreRaw } from "../../../../src/agents/auth-profiles/sqlite.js";
import type { ModelAuthLogoutResult } from "../../../../src/gateway/server-methods/models-auth-status.types.js";
import { createQuotaResetFixture } from "./quota-reset.test-support.js";

const ISOLATED_TEXT = '{"result":"QUOTA_ISOLATED_OK"}';
type QuotaFixture = Awaited<ReturnType<typeof createQuotaResetFixture>>;

const createFixture = (
  context: Parameters<typeof createQuotaResetFixture>[0],
  includeAlternateProfile = false,
) =>
  createQuotaResetFixture(context, {
    source: "wham",
    runtime: "openclaw",
    enableIsolatedTool: true,
    responseText: ISOLATED_TEXT,
    includeAlternateProfile,
  });
const isInference = (request: QuotaFixture["provider"]["requests"][number]) =>
  request.path.endsWith("/responses");
const isQuotaOrInference = (request: QuotaFixture["provider"]["requests"][number]) =>
  request.path === "/core-wham/usage" || isInference(request);

async function invokeIsolated(fixture: QuotaFixture, profileId = fixture.profileId) {
  const result = await fixture.client.request<ToolsInvokeResult>(
    "tools.invoke",
    {
      name: "llm-task",
      sessionKey: fixture.sessionKey,
      idempotencyKey: randomUUID(),
      args: {
        prompt: `Return ${ISOLATED_TEXT}.`,
        authProfileId: profileId,
        schema: {
          type: "object",
          properties: { result: { const: "QUOTA_ISOLATED_OK" } },
          required: ["result"],
          additionalProperties: false,
        },
        timeoutMs: 30_000,
      },
    },
    { timeoutMs: 40_000 },
  );
  fixture.turns.push({ isolated: result, profileId });
  return result;
}

async function expectIsolatedSuccess(fixture: QuotaFixture, profileId = fixture.profileId) {
  expect(await invokeIsolated(fixture, profileId), fixture.evidence()).toMatchObject({
    ok: true,
    toolName: "llm-task",
    source: "plugin",
    output: {
      content: [{ type: "text", text: expect.stringContaining('"QUOTA_ISOLATED_OK"') }],
      details: { json: { result: "QUOTA_ISOLATED_OK" } },
    },
  });
}

async function exhaustPrimary({ provider, turn, stats, evidence }: QuotaFixture) {
  provider.setPhase("initial-exhaustion");
  expect((await turn()).status, evidence()).toBe("error");
  expect(stats(), evidence()).toMatchObject({
    blockedSource: "wham",
    blockedReason: "subscription_limit",
  });
  expect(stats()?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + 86_400_000);
}

it(
  "recovers a registered isolated task after quota resets while rejecting exhausted capacity",
  { timeout: 600_000 },
  async (context) => {
    const fixture = await createFixture(context);
    const { provider, turn, stats, advanceClock, clock, evidence, access } = fixture;
    const check = <T>(value: T) => expect(value, evidence());
    check(await turn()).toEqual({ status: "ok", output: [ISOLATED_TEXT] });
    await expectIsolatedSuccess(fixture);

    await exhaustPrimary(fixture);

    provider.setPhase("restored");
    const beforeEarly = provider.requests.length;
    check(await invokeIsolated(fixture)).toMatchObject({ ok: false });
    check(provider.requests.slice(beforeEarly).filter(isQuotaOrInference)).toEqual([]);
    check(stats()?.blockedReason).toBe("subscription_limit");

    await advanceClock();
    const beforeRecovery = provider.requests.length;
    // The isolated caller must recover the block without an intervening ordinary turn.
    await expectIsolatedSuccess(fixture);
    const recoveryRequests = provider.requests.slice(beforeRecovery);
    check(recoveryRequests.filter(isQuotaOrInference).map((request) => request.path)).toEqual([
      "/core-wham/usage",
      "/direct/responses",
    ]);
    check(stats()?.blockedUntil).toBeUndefined();
    check(stats()?.blockedReason).toBeUndefined();
    check(stats()?.cooldownUntil).toBeUndefined();
    for (const request of recoveryRequests.filter(isQuotaOrInference)) {
      check(request.authorization).toBe(`Bearer ${access}`);
    }

    await exhaustPrimary(fixture);
    provider.setPhase("exhausted");
    await advanceClock();
    const beforeExhausted = provider.requests.length;
    check(await invokeIsolated(fixture)).toMatchObject({ ok: false });
    const exhaustedRequests = provider.requests.slice(beforeExhausted);
    check(exhaustedRequests.filter((request) => request.path === "/core-wham/usage")).toHaveLength(
      1,
    );
    check(exhaustedRequests.filter(isInference)).toEqual([]);
    check(stats()?.blockedReason).toBe("subscription_limit");
    check(stats()?.blockedUntil).toBeGreaterThan(Date.now() + clock.offset);
    check(provider.requests.filter((request) => request.path === "/oauth/token")).toEqual([]);
    check(provider.errors).toEqual([]);
  },
);

it(
  "rejects a pending isolated task after its pinned credential is removed",
  { timeout: 600_000 },
  async (context) => {
    const fixture = await createFixture(context, true);
    const { gateway, client, provider, turn, advanceClock, evidence } = fixture;
    const { profileId, alternateProfileId, alternateAccess, access } = fixture;
    const check = <T>(value: T) => expect(value, evidence());
    check(await turn()).toEqual({ status: "ok", output: [ISOLATED_TEXT] });
    await expectIsolatedSuccess(fixture);
    await expectIsolatedSuccess(fixture, alternateProfileId);

    await exhaustPrimary(fixture);

    provider.setPhase("restored");
    await advanceClock();
    const beforePending = provider.requests.length;
    const hold = provider.holdNextUsage();
    const pending = invokeIsolated(fixture);
    try {
      const first = await Promise.race([
        hold.arrived.then((captured) => ({ kind: "usage" as const, captured })),
        pending.then((result) => ({ kind: "result" as const, result })),
      ]);
      check(first.kind).toBe("usage");
      if (first.kind !== "usage") {
        throw new Error("Isolated task finished before its due quota request");
      }
      const { captured } = first;
      check(JSON.parse(captured.body)).toMatchObject({
        rate_limit: { allowed: true, limit_reached: false },
      });
      check(provider.requests.slice(beforePending).map((request) => request.authorization)).toEqual(
        [`Bearer ${access}`],
      );

      const logout = await client.request<ModelAuthLogoutResult>("models.authLogout", {
        provider: "openai",
        agentId: "main",
        profileIds: [profileId],
      });
      fixture.turns.push({ logout });
      check(logout).toMatchObject({ removedProfiles: [profileId], abortedRunIds: [] });
      const credentials = readPersistedSharedAuthProfileStoreRaw(gateway.env);
      check(credentials).not.toHaveProperty(["profiles", profileId]);
      check(credentials).toHaveProperty(["profiles", alternateProfileId]);
      check(captured.releaseReason).toBeUndefined();
      hold.release();

      check(await pending).toMatchObject({ ok: false });
      check(captured.releaseReason).toBe("explicit");
      check(provider.requests.slice(beforePending).filter(isInference)).toEqual([]);
      check(await invokeIsolated(fixture)).toMatchObject({ ok: false });
      check(provider.requests.slice(beforePending).filter(isInference)).toEqual([]);

      const beforeAlternate = provider.requests.length;
      await expectIsolatedSuccess(fixture, alternateProfileId);
      check(
        provider.requests
          .slice(beforeAlternate)
          .filter(isInference)
          .map((request) => ({ path: request.path, authorization: request.authorization })),
      ).toEqual([{ path: "/direct/responses", authorization: `Bearer ${alternateAccess}` }]);
      check(readPersistedSharedAuthProfileStoreRaw(gateway.env)).not.toHaveProperty([
        "profiles",
        profileId,
      ]);
      check(provider.errors).toEqual([]);
    } finally {
      hold.release();
      await pending;
    }
  },
);
