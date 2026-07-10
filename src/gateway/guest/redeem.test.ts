import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuestTestHarness,
  createRendezvous,
  type GuestTestHarness,
} from "./guest.test-helpers.js";
import {
  calculateGuestCodeExhaustionMs,
  GUEST_REDEEM_CODE_LOCKOUT_MS,
  GUEST_REDEEM_IP_MAX_ATTEMPTS,
  GUEST_REDEEM_IP_WINDOW_MS,
  GUEST_SHARE_CODE_SPACE_SIZE,
} from "./rate-limit.js";

describe("Wave 1 guest redemption", () => {
  const harnesses: GuestTestHarness[] = [];

  async function makeHarness(
    options: Parameters<typeof createGuestTestHarness>[0] = {},
  ): Promise<GuestTestHarness> {
    const harness = await createGuestTestHarness(options);
    harnesses.push(harness);
    return harness;
  }

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const harness of harnesses.splice(0)) {
      await harness.stop();
    }
  });

  it("W1-T2 security: Brute-force redeem → per-IP and per-code lockout; deterministic exhaustion-vs-expiry calculation + boundary tests (I7)", async () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const exhaustionMs = calculateGuestCodeExhaustionMs({
      codeSpaceSize: GUEST_SHARE_CODE_SPACE_SIZE,
      maxAttemptsPerWindow: GUEST_REDEEM_IP_MAX_ATTEMPTS,
      windowMs: GUEST_REDEEM_IP_WINDOW_MS,
    });
    expect(exhaustionMs).toBeGreaterThan(sevenDaysMs);

    const exactBoundarySpace =
      (sevenDaysMs / GUEST_REDEEM_IP_WINDOW_MS) * GUEST_REDEEM_IP_MAX_ATTEMPTS;
    expect(
      calculateGuestCodeExhaustionMs({
        codeSpaceSize: exactBoundarySpace,
        maxAttemptsPerWindow: GUEST_REDEEM_IP_MAX_ATTEMPTS,
        windowMs: GUEST_REDEEM_IP_WINDOW_MS,
      }),
    ).toBe(sevenDaysMs);
    expect(
      calculateGuestCodeExhaustionMs({
        codeSpaceSize: exactBoundarySpace + 1,
        maxAttemptsPerWindow: GUEST_REDEEM_IP_MAX_ATTEMPTS,
        windowMs: GUEST_REDEEM_IP_WINDOW_MS,
      }),
    ).toBeGreaterThan(sevenDaysMs);

    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const lockouts: Array<{ dimension: string; grantId: string }> = [];
    const harness = await makeHarness({
      rateLimit: {
        ip: { maxAttempts: 2, windowMs: 60_000, lockoutMs: 300_000 },
        code: { maxAttempts: 2, windowMs: 60_000, lockoutMs: GUEST_REDEEM_CODE_LOCKOUT_MS },
      },
      onLockout: (event) => lockouts.push(event),
    });
    const invited = harness.createGrant({
      audience: "deva-user",
      invitedPrincipal: { issuer: "deva", subject: "deva:expected" },
    });

    const first = await harness.controller.redeem({
      code: invited.code,
      clientIp: "198.51.100.7",
      identity: { issuer: "deva", subject: "deva:wrong" },
    });
    const second = await harness.controller.redeem({
      code: invited.code,
      clientIp: "198.51.100.7",
      identity: { issuer: "deva", subject: "deva:wrong" },
    });
    const locked = await harness.controller.redeem({
      code: invited.code,
      clientIp: "198.51.100.7",
      identity: { issuer: "deva", subject: "deva:expected" },
    });

    expect(first).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(second).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(locked).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(lockouts.map((event) => event.dimension).toSorted()).toEqual(["code", "ip"]);
  });

  it("W1-T9 security: Race redeems at maxConcurrentGuests: exactly the limit succeeds; failures leave no join/token records", async () => {
    const rendezvous = createRendezvous(8);
    const harness = await makeHarness({ hooks: { beforeRedeemCommit: rendezvous } });
    const grant = harness.createGrant({ maxConcurrentGuests: 3 });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        harness.controller.redeem({
          code: grant.code,
          clientIp: `198.51.100.${index + 1}`,
        }),
      ),
    );
    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);

    expect(successes).toHaveLength(3);
    expect(new Set(successes.map((result) => result.join.guestId)).size).toBe(3);
    expect(failures).toHaveLength(5);
    expect(failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: false, reason: "guest_limit" })]),
    );
    expect(harness.store.listJoins(grant.grant.grantId)).toHaveLength(3);
    for (const failure of failures) {
      expect(JSON.stringify(failure).toLowerCase()).not.toContain("token");
    }
  });

  it("W1-T21 security: Hostile displayName (Unicode/confusables/control/HTML/terminal escapes/oversized) normalized or rejected; never alters logs/UI/terminal", async () => {
    const hostNotifications: unknown[] = [];
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = await makeHarness({ onLockout: (event) => hostNotifications.push(event) });
    const normalizedGrant = harness.createGrant();

    const normalized = await harness.controller.redeem({
      code: normalizedGrant.code,
      clientIp: "198.51.100.20",
      displayName: "  Ｇｕｅｓｔ　Viewer  ",
    });
    expect(normalized).toMatchObject({
      ok: true,
      join: { displayName: "Guest Viewer" },
    });

    const hostileNames = [
      "Guest\u0000Admin",
      "Guest\u001b[2JAdmin",
      '<img src=x onerror="alert(1)">',
      "Gueѕt Admin",
      "x".repeat(65),
    ];
    for (const [index, displayName] of hostileNames.entries()) {
      const grant = harness.createGrant();
      await expect(
        harness.controller.redeem({
          code: grant.code,
          clientIp: `198.51.100.${30 + index}`,
          displayName,
        }),
      ).resolves.toMatchObject({ ok: false, reason: "invalid_display_name" });
      expect(harness.store.listJoins(grant.grant.grantId)).toEqual([]);
    }

    const observableText = JSON.stringify({ hostNotifications, warnings: consoleWarn.mock.calls });
    for (const displayName of hostileNames) {
      expect(observableText).not.toContain(displayName);
    }
  });

  it("W1-T22 security: Rate-limit boundaries, IP normalization, proxy-header trust, distributed attempts, lockout expiry, notification dedupe — deterministic (I7)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const lockouts: Array<{ dimension: string; grantId: string; lockedUntilMs: number }> = [];
    const harness = await makeHarness({
      rateLimit: {
        ip: { maxAttempts: 2, windowMs: 60_000, lockoutMs: 120_000 },
        code: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 180_000 },
      },
      onLockout: (event) => lockouts.push(event),
    });
    const invited = harness.createGrant({
      audience: "deva-user",
      invitedPrincipal: { issuer: "deva", subject: "deva:expected" },
    });

    const attempts = ["198.51.100.1", "::ffff:198.51.100.2", "198.51.100.3"];
    for (const clientIp of attempts) {
      await harness.controller.redeem({
        code: invited.code,
        clientIp,
        identity: { issuer: "deva", subject: "deva:wrong" },
      });
    }
    expect(
      await harness.controller.redeem({
        code: invited.code,
        clientIp: "198.51.100.4",
        identity: { issuer: "deva", subject: "deva:expected" },
      }),
    ).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(lockouts.filter((event) => event.dimension === "code")).toHaveLength(1);

    await harness.controller.redeem({
      code: invited.code,
      clientIp: "198.51.100.5",
      identity: { issuer: "deva", subject: "deva:wrong" },
    });
    expect(lockouts.filter((event) => event.dimension === "code")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(
      await harness.controller.redeem({
        code: invited.code,
        clientIp: "198.51.100.4",
        identity: { issuer: "deva", subject: "deva:expected" },
      }),
    ).toMatchObject({ ok: true });

    const untrustedProxy = await makeHarness({
      rateLimit: {
        ip: { maxAttempts: 2, windowMs: 60_000, lockoutMs: 120_000 },
        code: { maxAttempts: 20, windowMs: 60_000, lockoutMs: 120_000 },
      },
      trustedProxies: [],
    });
    const badCodes = ["AAA-AAA", "BBB-BBB", "CCC-CCC"];
    const proxyStatuses: number[] = [];
    for (const [index, code] of badCodes.entries()) {
      const attempt = await untrustedProxy.redeem(
        code,
        {},
        {
          "x-forwarded-for": `203.0.113.${index + 1}`,
        },
      );
      proxyStatuses.push(attempt.response.status);
    }
    expect(proxyStatuses).toEqual([401, 401, 429]);

    const trustedProxy = await makeHarness({
      rateLimit: {
        ip: { maxAttempts: 2, windowMs: 60_000, lockoutMs: 120_000 },
        code: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 120_000 },
      },
      trustedProxies: ["127.0.0.1"],
      verifyIdentityAssertion: async (assertion) => ({ issuer: "deva", subject: assertion }),
    });
    const distributed = trustedProxy.createGrant({
      audience: "deva-user",
      invitedPrincipal: { issuer: "deva", subject: "expected" },
    });
    const distributedStatuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const attempt = await trustedProxy.redeem(
        distributed.code,
        { identityAssertion: index === 3 ? "expected" : "wrong" },
        { "x-forwarded-for": `203.0.113.${index + 1}` },
      );
      distributedStatuses.push(attempt.response.status);
    }
    expect(distributedStatuses).toEqual([401, 401, 401, 429]);
  });
});
