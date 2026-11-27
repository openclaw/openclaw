import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolsInvokeResult } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { readPersistedSharedAuthProfileStoreRaw } from "../../../../src/agents/auth-profiles/sqlite.js";
import type { ModelAuthLogoutResult } from "../../../../src/gateway/server-methods/models-auth-status.types.js";
import { createQuotaResetFixture } from "./quota-reset.test-support.js";

const ISOLATED_TEXT = '{"result":"QUOTA_ISOLATED_OK"}';
type QuotaFixture = Awaited<ReturnType<typeof createQuotaResetFixture>>;

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

function expectIsolatedSuccess(result: ToolsInvokeResult, evidence: string) {
  expect(result, evidence).toMatchObject({
    ok: true,
    toolName: "llm-task",
    source: "plugin",
    output: {
      content: [{ type: "text", text: expect.stringContaining('"QUOTA_ISOLATED_OK"') }],
      details: { json: { result: "QUOTA_ISOLATED_OK" } },
    },
  });
}

describe("Gateway isolated task quota recovery", () => {
  it(
    "recovers a registered isolated task after quota resets while rejecting exhausted capacity",
    { timeout: 600_000 },
    async (context) => {
      const fixture = await createQuotaResetFixture(context, {
        source: "wham",
        runtime: "openclaw",
        enableIsolatedTool: true,
        responseText: ISOLATED_TEXT,
      });
      const { provider, turn, stats, advanceClock, clock, evidence, access } = fixture;
      expect(await turn(), evidence()).toEqual({ status: "ok", output: [ISOLATED_TEXT] });
      expectIsolatedSuccess(await invokeIsolated(fixture), evidence());

      provider.setPhase("initial-exhaustion");
      expect((await turn()).status, evidence()).toBe("error");
      expect(stats(), evidence()).toMatchObject({
        blockedSource: "wham",
        blockedReason: "subscription_limit",
      });
      expect(stats()?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + 86_400_000);

      provider.setPhase("restored");
      const beforeEarly = provider.requests.length;
      expect(await invokeIsolated(fixture), evidence()).toMatchObject({ ok: false });
      expect(
        provider.requests
          .slice(beforeEarly)
          .filter(
            (request) => request.path === "/core-wham/usage" || request.path.endsWith("/responses"),
          ),
        evidence(),
      ).toEqual([]);
      expect(stats()?.blockedReason, evidence()).toBe("subscription_limit");

      await advanceClock();
      const beforeRecovery = provider.requests.length;
      // The isolated caller must recover the block without an intervening ordinary turn.
      expectIsolatedSuccess(await invokeIsolated(fixture), evidence());
      const recoveryRequests = provider.requests.slice(beforeRecovery);
      expect(
        recoveryRequests
          .filter(
            (request) => request.path === "/core-wham/usage" || request.path.endsWith("/responses"),
          )
          .map((request) => request.path),
        evidence(),
      ).toEqual(["/core-wham/usage", "/direct/responses"]);
      expect(stats()?.blockedUntil, evidence()).toBeUndefined();
      expect(stats()?.blockedReason, evidence()).toBeUndefined();
      expect(stats()?.cooldownUntil, evidence()).toBeUndefined();
      for (const request of recoveryRequests.filter(
        (entry) => entry.path === "/core-wham/usage" || entry.path.endsWith("/responses"),
      )) {
        expect(request.authorization, evidence()).toBe(`Bearer ${access}`);
      }

      provider.setPhase("initial-exhaustion");
      expect((await turn()).status, evidence()).toBe("error");
      expect(stats(), evidence()).toMatchObject({
        blockedSource: "wham",
        blockedReason: "subscription_limit",
      });
      provider.setPhase("exhausted");
      await advanceClock();
      const beforeExhausted = provider.requests.length;
      expect(await invokeIsolated(fixture), evidence()).toMatchObject({ ok: false });
      const exhaustedRequests = provider.requests.slice(beforeExhausted);
      expect(
        exhaustedRequests.filter((request) => request.path === "/core-wham/usage"),
        evidence(),
      ).toHaveLength(1);
      expect(
        exhaustedRequests.filter((request) => request.path.endsWith("/responses")),
        evidence(),
      ).toEqual([]);
      expect(stats()?.blockedReason, evidence()).toBe("subscription_limit");
      expect(stats()?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + clock.offset);
      expect(
        provider.requests.filter((request) => request.path === "/oauth/token"),
        evidence(),
      ).toEqual([]);
      expect(provider.errors, evidence()).toEqual([]);
    },
  );

  it(
    "rejects a pending isolated task after its pinned credential is removed",
    { timeout: 600_000 },
    async (context) => {
      const fixture = await createQuotaResetFixture(context, {
        source: "wham",
        runtime: "openclaw",
        enableIsolatedTool: true,
        responseText: ISOLATED_TEXT,
        includeAlternateProfile: true,
      });
      const {
        gateway,
        client,
        provider,
        turn,
        stats,
        advanceClock,
        evidence,
        profileId,
        alternateProfileId,
        alternateAccess,
        access,
      } = fixture;
      expect(await turn(), evidence()).toEqual({ status: "ok", output: [ISOLATED_TEXT] });
      expectIsolatedSuccess(await invokeIsolated(fixture), evidence());
      expectIsolatedSuccess(await invokeIsolated(fixture, alternateProfileId), evidence());

      provider.setPhase("initial-exhaustion");
      expect((await turn()).status, evidence()).toBe("error");
      expect(stats(), evidence()).toMatchObject({
        blockedSource: "wham",
        blockedReason: "subscription_limit",
      });
      expect(stats()?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + 86_400_000);

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
        expect(first.kind, evidence()).toBe("usage");
        if (first.kind !== "usage") {
          throw new Error("Isolated task finished before its due quota request");
        }
        const { captured } = first;
        expect(JSON.parse(captured.body), evidence()).toMatchObject({
          rate_limit: { allowed: true, limit_reached: false },
        });
        expect(
          provider.requests.slice(beforePending).map((request) => request.authorization),
          evidence(),
        ).toEqual([`Bearer ${access}`]);

        const logout = await client.request<ModelAuthLogoutResult>("models.authLogout", {
          provider: "openai",
          agentId: "main",
          profileIds: [profileId],
        });
        fixture.turns.push({ logout });
        expect(logout.removedProfiles, evidence()).toEqual([profileId]);
        expect(logout.abortedRunIds, evidence()).toEqual([]);
        const credentials = readPersistedSharedAuthProfileStoreRaw(gateway.env);
        expect(credentials, evidence()).not.toHaveProperty(["profiles", profileId]);
        expect(credentials, evidence()).toHaveProperty(["profiles", alternateProfileId]);
        expect(captured.releaseReason, evidence()).toBeUndefined();
        hold.release();

        expect(await pending, evidence()).toMatchObject({ ok: false });
        expect(captured.releaseReason, evidence()).toBe("explicit");
        expect(
          provider.requests
            .slice(beforePending)
            .filter((request) => request.path.endsWith("/responses")),
          evidence(),
        ).toEqual([]);
        expect(await invokeIsolated(fixture), evidence()).toMatchObject({ ok: false });
        expect(
          provider.requests
            .slice(beforePending)
            .filter((request) => request.path.endsWith("/responses")),
          evidence(),
        ).toEqual([]);

        const beforeAlternate = provider.requests.length;
        expectIsolatedSuccess(await invokeIsolated(fixture, alternateProfileId), evidence());
        expect(
          provider.requests
            .slice(beforeAlternate)
            .filter((request) => request.path.endsWith("/responses"))
            .map((request) => ({ path: request.path, authorization: request.authorization })),
          evidence(),
        ).toEqual([{ path: "/direct/responses", authorization: `Bearer ${alternateAccess}` }]);
        expect(readPersistedSharedAuthProfileStoreRaw(gateway.env), evidence()).not.toHaveProperty([
          "profiles",
          profileId,
        ]);
        expect(provider.errors, evidence()).toEqual([]);
      } finally {
        hold.release();
        await pending;
      }
    },
  );
});
