import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  ACCOUNT_ID,
  BACKUP_API_KEY,
  BACKUP_MARKER,
  BACKUP_MODEL,
  BACKUP_RESPONSES_PATH,
  MARKER,
  UTILITY_MODEL_ID,
  createQuotaResetFixture,
  installQuotaStateWriteFault,
  syntheticAccessToken,
} from "./quota-reset.test-support.js";

const newSession = () => `agent:main:quota-${randomUUID()}`;
const ok = (marker = MARKER) => ({ status: "ok", output: [marker] });
const usageLimit = (limited: boolean) => ({
  rate_limit: expect.objectContaining({
    allowed: !limited,
    limit_reached: limited,
    primary_window: expect.objectContaining({ used_percent: limited ? 100 : 2 }),
    secondary_window: expect.objectContaining({ used_percent: limited ? 100 : 2 }),
  }),
});

it.for([
  ["wham", false, false, false, false],
  ["codex_rate_limits", false, false, false, false],
  ["wham", true, false, false, false],
  ["codex_rate_limits", false, true, false, false],
  ["codex_rate_limits", false, true, true, false],
  ["codex_rate_limits", false, true, false, true],
] as const)(
  "recovers chat without admitting exhausted or revoked auth (%s, expired=%s, scoped=%s, available=%s, stale-success=%s)",
  { timeout: 600_000 },
  async (
    [source, expiresDuringBlock, scopedCooldown, availableProbeCooldown, staleUsageAfterSuccess],
    context,
  ) => {
    const fixture = await createQuotaResetFixture(context, {
      source,
      expiresDuringBlock,
      scopedCooldown,
    });
    const { client, provider, sessionKey, access } = fixture;
    const { advanceClock, clock, stats, evidence, turn } = fixture;
    const check = <T>(value: T) => expect(value, evidence());
    const askCompanion = (key = sessionKey, question = `Return ${MARKER}.`) =>
      client.request<{ answer: string }>(
        "sessions.companion.ask",
        { sessionKey: key, question },
        { timeoutMs: 100_000 },
      );
    type Request = (typeof provider.requests)[number];
    const isUsage = (request: Request) => request.path === "/core-wham/usage";
    const isResponse = (request: Request) => request.path.endsWith("/responses");
    const isInference = (request: Request) =>
      request.transport === "websocket" || isResponse(request);
    const utilityCooldown = { cooldownModel: UTILITY_MODEL_ID, cooldownReason: "rate_limit" };
    const modelBlock = { blockedModel: "gpt-5.5", blockedScope: "model" };
    const phaseRequests = (phase: Request["phase"], match: (request: Request) => boolean) =>
      provider.requests.filter((request) => request.phase === phase && match(request));
    const checkSuccess = async (key = sessionKey) => check(await turn(key)).toEqual(ok());
    const checkBlockedTurn = async (phase?: Request["phase"], advance = false) => {
      if (phase) {
        provider.setPhase(phase);
      }
      if (advance) {
        await advanceClock();
      }
      const result = await turn();
      check(result.status).toBe("error");
      check(result.output).not.toContain(MARKER);
    };
    await checkSuccess();
    if (staleUsageAfterSuccess) {
      const companionSessionKey = newSession();
      await checkSuccess(companionSessionKey);
      check((await askCompanion(companionSessionKey)).answer).toBe(MARKER);
      const beforeOverlap = stats();
      check(beforeOverlap?.blockedUntil).toBeUndefined();
      check(beforeOverlap?.blockedReason).toBeUndefined();

      provider.setPhase("ordinary-rate-limit-with-exhausted-usage");
      const hold = provider.holdNextUsage();
      const olderCompanion = askCompanion(
        companionSessionKey,
        "Return the older request's answer.",
      ).then(
        (result) => ({ status: "ok", result }),
        (error: unknown) => ({ status: "error", error: String(error) }),
      );
      try {
        await expect
          .poll(() => provider.heldUsageResponses.length, { timeout: 2800, interval: 10 })
          .toBe(1);
        const captured = await hold.arrived;
        check(captured.status).toBe(200);
        check(JSON.parse(captured.body)).toMatchObject(usageLimit(true));
        provider.setPhase("healthy");
        await checkSuccess();
        const newerSuccessCompletedAt = Date.now();
        const beforeRelease = stats();
        check(captured.releaseReason).toBeUndefined();
        check(beforeRelease?.blockedUntil).toBeUndefined();
        check(newerSuccessCompletedAt).toBeGreaterThanOrEqual(captured.capturedAt);
        hold.release();
        check((await olderCompanion).status).toBe("error");
        const afterRelease = stats();
        check(captured.releaseReason).toBe("explicit");
        check(captured.releasedAt).toBeGreaterThanOrEqual(newerSuccessCompletedAt);
        await checkSuccess();
        check(afterRelease?.blockedUntil).toBeUndefined();
        check(afterRelease?.blockedReason).toBeUndefined();
        for (const request of provider.requests.filter(
          (entry) => isInference(entry) || isUsage(entry),
        )) {
          check(request.authorization).toBe(`Bearer ${access}`);
        }
        check(provider.errors).toEqual([]);
      } finally {
        hold.release();
        await olderCompanion;
      }
      return;
    }
    const quotaSessions =
      source === "codex_rate_limits" ? [sessionKey, newSession(), newSession()] : [sessionKey];
    for (const key of quotaSessions.slice(1)) {
      await checkSuccess(key);
    }
    provider.setPhase("initial-exhaustion");
    for (const blocked of await Promise.all(quotaSessions.map((key) => turn(key)))) {
      check(blocked.status).toBe("error");
      check(blocked.output).not.toContain(MARKER);
    }
    check(stats()).toMatchObject({ blockedSource: source, blockedReason: "subscription_limit" });
    check(stats()?.blockedUntil).toBeGreaterThan(Date.now() + 86_400_000);

    if (availableProbeCooldown) {
      check(stats()).toMatchObject(modelBlock);
      await advanceClock();
      provider.setPhase("ordinary-rate-limit-with-capacity");
      await check(askCompanion()).rejects.toThrow();
      const afterUtilityFailure = stats();
      check(afterUtilityFailure).toMatchObject(utilityCooldown);
      const utilityUntil = afterUtilityFailure?.cooldownUntil;
      check(utilityUntil).toBeGreaterThan(Date.now() + clock.offset);
      check(provider.responses).toContainEqual({
        atMs: expect.any(Number),
        status: 200,
        transport: "http",
        phase: "ordinary-rate-limit-with-capacity",
        path: "/core-wham/usage",
        value: expect.objectContaining(usageLimit(false)),
        headers: {},
      });
      let beforeReply: ReturnType<typeof stats>;
      provider.observeNextSuccess(
        () => {
          beforeReply = stats();
        },
        { model: "gpt-5.5", path: "/v1/responses" },
      );
      provider.setPhase("restored");
      await checkSuccess();
      check(beforeReply?.blockedUntil).toBeUndefined();
      check(beforeReply).toMatchObject({ ...utilityCooldown, cooldownUntil: utilityUntil });
      check(provider.errors).toEqual([]);
      return;
    }

    if (scopedCooldown) {
      provider.setPhase("ordinary-rate-limit");
      for (let attempt = 0; attempt < 4; attempt++) {
        await check(askCompanion()).rejects.toThrow();
        check(stats()).toMatchObject({ ...modelBlock, ...utilityCooldown });
        if (attempt < 3) {
          const cooldownUntil = stats()?.cooldownUntil;
          check(cooldownUntil).toEqual(expect.any(Number));
          if (cooldownUntil === undefined) {
            throw new Error("Companion failure did not persist its retry deadline");
          }
          await advanceClock(Math.max(1, cooldownUntil - Date.now() - clock.offset + 1));
        }
      }
      provider.setPhase("restored");
      await advanceClock();
      check(stats()?.cooldownUntil).toBeGreaterThan(Date.now() + clock.offset);
      await checkSuccess();
      check(stats()?.blockedUntil).toBeUndefined();
      check(provider.errors).toEqual([]);
      return;
    }

    if (source === "codex_rate_limits") {
      const originalGeneration = stats();
      check(originalGeneration?.lastFailureAt).toEqual(expect.any(Number));
      check(originalGeneration?.failureCounts?.rate_limit).toBeGreaterThan(0);
      for (const phase of [
        "additional-exhaustion",
        "workspace-exhaustion",
        "spending-exhaustion",
        "malformed-usage",
      ] as const) {
        await checkBlockedTurn(phase, true);
        const retained = stats();
        check(retained?.blockedReason).toBe("subscription_limit");
        check(retained?.blockedUntil).toBeGreaterThan(Date.now() + clock.offset);
        check(retained?.lastFailureAt).toBe(originalGeneration?.lastFailureAt);
        check(retained?.failureCounts).toEqual(originalGeneration?.failureCounts);
        check(phaseRequests(phase, isUsage)).not.toHaveLength(0);
        // A fresh exhausted bucket must not become another failed inference attempt.
        check(phaseRequests(phase, isInference)).toEqual([]);
      }
    }

    await checkBlockedTurn("exhausted", !expiresDuringBlock);
    check(stats()?.blockedUntil).toBeGreaterThan(Date.now() + clock.offset);

    await checkBlockedTurn("restored");
    check(phaseRequests("restored", isUsage)).toEqual([]);
    await advanceClock();
    await checkSuccess();
    check(stats()?.blockedUntil).toBeUndefined();
    if (expiresDuringBlock) {
      const refreshes = provider.requests.filter((request) => request.path === "/oauth/token");
      check(refreshes).toHaveLength(1);
      check(refreshes[0]?.body).toContain("synthetic-refresh");
    }
    check(phaseRequests("restored", isUsage)).not.toHaveLength(0);
    check(phaseRequests("restored", isResponse)).not.toHaveLength(0);

    await checkBlockedTurn("revoked");
    await checkBlockedTurn(undefined, true);
    for (const request of provider.requests.filter(
      (entry) => isResponse(entry) || isUsage(entry),
    )) {
      const refreshed =
        expiresDuringBlock && (request.phase === "restored" || request.phase === "revoked");
      // The native process retains its real clock and may reuse the bound session's token.
      const nativeRefresh = refreshed && isResponse(request);
      const allowed = [refreshed ? syntheticAccessToken() : access];
      if (nativeRefresh) {
        allowed.push(access);
      }
      check(allowed.map((token) => `Bearer ${token}`)).toContain(request.authorization);
      if (nativeRefresh || isUsage(request)) {
        check(request.accountId).toBe(ACCOUNT_ID);
      }
    }
    check(provider.errors).toEqual([]);
  },
);

it.for([
  { write: "claim", failure: "io" },
  { write: "result", failure: "io" },
  { write: "claim", failure: "constraint" },
] as const)(
  "preserves healthy fallback and refuses constraints for quota $write write $failure failure",
  { timeout: 600_000, skip: process.platform === "win32" },
  async ({ write, failure }, context) => {
    const { client, provider, gateway, turn, stats, evidence, advanceClock, storageFaultFile } =
      await createQuotaResetFixture(context, {
        source: "codex_rate_limits",
        includeBackup: true,
        limitGatewayFileSize: true,
      });
    const check = <T>(value: T) => expect(value, evidence());
    const checkBackup = (result: Awaited<ReturnType<typeof turn>>) =>
      check(result).toEqual(ok(BACKUP_MARKER));
    check(await turn()).toEqual(ok());

    const directBackupSession = newSession();
    await client.request("sessions.patch", { key: directBackupSession, model: BACKUP_MODEL });
    checkBackup(await turn(directBackupSession));

    provider.setPhase("initial-exhaustion");
    const initialFallback = await turn(newSession());
    check(initialFallback.status).toBe("ok");
    check(initialFallback.output).toContain(BACKUP_MARKER);
    check(stats()).toMatchObject({
      blockedSource: "codex_rate_limits",
      blockedReason: "subscription_limit",
    });
    const blockedUntil = stats()?.blockedUntil;
    check(blockedUntil).toBeGreaterThan(Date.now() + 86_400_000);

    provider.setPhase("restored");
    await advanceClock();
    const fault = await installQuotaStateWriteFault(gateway, storageFaultFile, write, failure);
    try {
      checkBackup(await turn(directBackupSession, "Before fault"));
      const beforeFault = provider.requests.length;
      const prompt = `Quota ${write} ${failure}`;
      // Fresh sessions use configured order, not a previous turn's automatic fallback.
      const fallback = await turn(newSession(), prompt);
      const backupAfterFault = await turn(directBackupSession, "After fault");

      check(gateway.logs()).toContain(
        failure === "io" ? "disk I/O error" : "quota test constraint invariant",
      );
      check(gateway.logs()).toContain(`errcode: ${failure === "io" ? 778 : 1811}`);
      check(fault.scratchCommitted()).toBe(false);
      checkBackup(backupAfterFault);
      check(fallback.status).toBe(failure === "io" ? "ok" : "error");
      check(fallback.output.includes(BACKUP_MARKER)).toBe(failure === "io");
      const faultRequests = provider.requests.slice(beforeFault);
      check(
        faultRequests.filter(
          (request) =>
            request.path !== BACKUP_RESPONSES_PATH &&
            (request.transport === "websocket" || request.path.endsWith("/responses")),
        ),
      ).toEqual([]);
      check(faultRequests.filter((request) => request.path === "/core-wham/usage")).toHaveLength(
        write === "claim" ? 0 : 1,
      );
      const fallbackRequests = faultRequests.filter((request) => request.body?.includes(prompt));
      if (failure === "io") {
        check(fallbackRequests).toContainEqual(
          expect.objectContaining({
            path: BACKUP_RESPONSES_PATH,
            authorization: `Bearer ${BACKUP_API_KEY}`,
          }),
        );
      } else {
        check(fallbackRequests).toEqual([]);
      }
      check(stats()).toMatchObject({ blockedReason: "subscription_limit", blockedUntil });
      check(provider.errors).toEqual([]);
    } finally {
      await fault.remove();
    }
    await advanceClock();
    check(await turn(newSession())).toEqual(ok());
    check(stats()?.blockedUntil).toBeUndefined();
  },
);
