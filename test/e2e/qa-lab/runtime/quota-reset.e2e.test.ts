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
    const { advanceClock, clock, stats, evidence, turn, turns } = fixture;
    const check = <T>(value: T) => expect(value, evidence());
    const askCompanion = (key = sessionKey, question = `Return ${MARKER}.`) =>
      client.request<{ answer: string }>(
        "sessions.companion.ask",
        { sessionKey: key, question },
        { timeoutMs: 100_000 },
      );
    type Request = (typeof provider.requests)[number];
    const isUsage = (request: Request) => request.path === "/core-wham/usage";
    const isInference = (request: Request) =>
      request.transport === "websocket" || request.path.endsWith("/responses");
    const phaseRequests = (phase: Request["phase"], match: (request: Request) => boolean) =>
      provider.requests.filter((request) => request.phase === phase && match(request));
    const checkSuccess = async (key = sessionKey) =>
      check(await turn(key)).toEqual({ status: "ok", output: [MARKER] });
    const checkBlockedTurn = (result: Awaited<ReturnType<typeof turn>>) => {
      check(result.status).toBe("error");
      check(result.output).not.toContain(MARKER);
    };
    await checkSuccess();
    if (staleUsageAfterSuccess) {
      const companionSessionKey = `agent:main:quota-companion-${randomUUID()}`;
      await checkSuccess(companionSessionKey);
      const warmCompanion = await askCompanion(companionSessionKey);
      turns.push({ warmCompanion });
      check(warmCompanion.answer).toBe(MARKER);
      const beforeOverlap = stats();
      turns.push({ beforeOverlap });
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
        check(JSON.parse(captured.body)).toMatchObject({
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: { used_percent: 100 },
            secondary_window: { used_percent: 100 },
          },
        });
        provider.setPhase("healthy");
        await checkSuccess();
        const newerSuccessCompletedAt = Date.now();
        const beforeRelease = stats();
        turns.push({ newerSuccessCompletedAt, beforeRelease });
        check(captured.releaseReason).toBeUndefined();
        check(beforeRelease?.blockedUntil).toBeUndefined();
        check(newerSuccessCompletedAt).toBeGreaterThanOrEqual(captured.capturedAt);
        hold.release();
        const olderResult = await olderCompanion;
        const afterRelease = stats();
        turns.push({ olderResult, afterRelease });
        check(olderResult.status).toBe("error");
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
      source === "codex_rate_limits"
        ? [sessionKey, `agent:main:quota-${randomUUID()}`, `agent:main:quota-${randomUUID()}`]
        : [sessionKey];
    for (const key of quotaSessions.slice(1)) {
      await checkSuccess(key);
    }
    provider.setPhase("initial-exhaustion");
    for (const blocked of await Promise.all(quotaSessions.map((key) => turn(key)))) {
      checkBlockedTurn(blocked);
    }
    check(stats()).toMatchObject({
      blockedSource: source,
      blockedReason: "subscription_limit",
    });
    check(stats()?.blockedUntil).toBeGreaterThan(Date.now() + 86_400_000);

    if (availableProbeCooldown) {
      check(stats()).toMatchObject({
        blockedModel: "gpt-5.5",
        blockedScope: "model",
      });
      await advanceClock();
      provider.setPhase("ordinary-rate-limit-with-capacity");
      await check(askCompanion()).rejects.toThrow();
      const afterUtilityFailure = stats();
      turns.push({ afterUtilityFailure });
      check(afterUtilityFailure).toMatchObject({
        cooldownModel: UTILITY_MODEL_ID,
        cooldownReason: "rate_limit",
      });
      const ordinaryCooldown = afterUtilityFailure?.cooldownUntil;
      check(ordinaryCooldown).toBeGreaterThan(Date.now() + clock.offset);
      check(provider.responses).toContainEqual({
        atMs: expect.any(Number),
        status: 200,
        transport: "http",
        phase: "ordinary-rate-limit-with-capacity",
        path: "/core-wham/usage",
        value: expect.objectContaining({
          rate_limit: expect.objectContaining({
            allowed: true,
            limit_reached: false,
            primary_window: expect.objectContaining({ used_percent: 2 }),
            secondary_window: expect.objectContaining({ used_percent: 2 }),
          }),
        }),
        headers: {},
      });
      let beforeRecoveryReply: ReturnType<typeof stats>;
      provider.observeNextSuccess(
        () => {
          beforeRecoveryReply = stats();
          turns.push({ beforeRecoveryReply });
        },
        { model: "gpt-5.5", path: "/v1/responses" },
      );
      provider.setPhase("restored");
      await checkSuccess();
      check(beforeRecoveryReply?.blockedUntil).toBeUndefined();
      check(beforeRecoveryReply).toMatchObject({
        cooldownModel: UTILITY_MODEL_ID,
        cooldownReason: "rate_limit",
        cooldownUntil: ordinaryCooldown,
      });
      check(provider.errors).toEqual([]);
      return;
    }

    if (scopedCooldown) {
      provider.setPhase("ordinary-rate-limit");
      for (let attempt = 0; attempt < 4; attempt++) {
        await check(askCompanion()).rejects.toThrow();
        check(stats()).toMatchObject({
          blockedModel: "gpt-5.5",
          blockedScope: "model",
          cooldownModel: UTILITY_MODEL_ID,
          cooldownReason: "rate_limit",
        });
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
        provider.setPhase(phase);
        await advanceClock();
        checkBlockedTurn(await turn());
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

    provider.setPhase("exhausted");
    if (!expiresDuringBlock) {
      await advanceClock();
    }
    checkBlockedTurn(await turn());
    check(stats()?.blockedUntil).toBeGreaterThan(Date.now() + clock.offset);

    provider.setPhase("restored");
    checkBlockedTurn(await turn());
    check(phaseRequests("restored", isUsage)).toEqual([]);
    await advanceClock();
    await checkSuccess();
    check(stats()?.blockedUntil).toBeUndefined();
    if (expiresDuringBlock) {
      const refreshRequests = provider.requests.filter(
        (request) => request.path === "/oauth/token",
      );
      check(refreshRequests).toHaveLength(1);
      check(refreshRequests[0]?.body).toContain("synthetic-refresh");
    }
    check(phaseRequests("restored", isUsage)).not.toHaveLength(0);
    check(
      phaseRequests("restored", (request) => request.path.endsWith("/responses")),
    ).not.toHaveLength(0);

    provider.setPhase("revoked");
    checkBlockedTurn(await turn());
    await advanceClock();
    checkBlockedTurn(await turn());
    for (const request of provider.requests.filter(
      (entry) => entry.path.endsWith("/responses") || entry.path === "/core-wham/usage",
    )) {
      const refreshed =
        expiresDuringBlock && (request.phase === "restored" || request.phase === "revoked");
      // The native process retains its real clock and may reuse the bound session's token.
      if (refreshed && request.path.endsWith("/responses")) {
        check([`Bearer ${access}`, `Bearer ${syntheticAccessToken()}`]).toContain(
          request.authorization,
        );
        check(request.accountId).toBe(ACCOUNT_ID);
      } else {
        check(request.authorization).toBe(`Bearer ${refreshed ? syntheticAccessToken() : access}`);
      }
    }
    for (const request of provider.requests.filter(isUsage)) {
      check(request.accountId).toBe(ACCOUNT_ID);
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
      check(result).toEqual({ status: "ok", output: [BACKUP_MARKER] });
    check(await turn()).toEqual({ status: "ok", output: [MARKER] });

    const directBackupSession = `agent:main:quota-backup-${randomUUID()}`;
    await client.request("sessions.patch", { key: directBackupSession, model: BACKUP_MODEL });
    checkBackup(await turn(directBackupSession));

    provider.setPhase("initial-exhaustion");
    const initialFallback = await turn(`agent:main:quota-initial-fallback-${randomUUID()}`);
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
      checkBackup(await turn(directBackupSession, `Direct backup before ${write} I/O failure.`));
      const beforeFault = provider.requests.length;
      const prompt = `Ordinary chat during the quota ${write} write ${failure} failure.`;
      // A new ordinary session uses configured primary/fallback order instead
      // of a previous turn's automatic model preference.
      const fallback = await turn(`agent:main:quota-storage-fallback-${randomUUID()}`, prompt);
      const backupAfterFault = await turn(
        directBackupSession,
        `Direct backup after ${write} I/O failure.`,
      );

      check(gateway.logs()).toContain(
        failure === "io" ? "disk I/O error" : "quota test constraint invariant",
      );
      check(gateway.logs()).toContain(`errcode: ${failure === "io" ? 778 : 1811}`);
      check(fault.scratchCommitted()).toBe(false);
      checkBackup(backupAfterFault);
      check(fallback.status).toBe(failure === "io" ? "ok" : "error");
      if (failure === "io") {
        check(fallback.output).toContain(BACKUP_MARKER);
      } else {
        check(fallback.output).not.toContain(BACKUP_MARKER);
      }
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
      check(stats()).toMatchObject({
        blockedReason: "subscription_limit",
        blockedUntil,
      });
      check(provider.errors).toEqual([]);
    } finally {
      await fault.remove();
    }
    await advanceClock();
    check(await turn(`agent:main:quota-after-fault-${randomUUID()}`)).toEqual({
      status: "ok",
      output: [MARKER],
    });
    check(stats()?.blockedUntil).toBeUndefined();
  },
);
