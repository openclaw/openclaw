import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const {
  handleTrustCommand,
  handleUntrustCommand,
  resolveTrustedExecSecurity,
  resetTrustCommandForTests,
} = await import("./commands-trust.js");

function buildParams(commandBody: string) {
  const cfg = {
    commands: { text: true },
  } as OpenClawConfig;
  return buildCommandTestParams(commandBody, cfg);
}

describe("trust commands", () => {
  beforeEach(() => {
    resetTrustCommandForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));
  });

  afterEach(() => {
    resetTrustCommandForTests();
    vi.useRealTimers();
  });

  it("enables trust with the default 15-minute window", async () => {
    const params = buildParams("/trust");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };

    const result = await handleTrustCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("15m");
    expect(resolveTrustedExecSecurity(params.sessionEntry.sessionId)).toBe("full");
    expect(params.sessionEntry.execSecurity).toBeUndefined();
  });

  it("refuses trust extension while an active window exists", async () => {
    const params = buildParams("/trust 5");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };

    await handleTrustCommand(params, true);

    const extendParams = buildParams("/trust 30");
    extendParams.sessionEntry = params.sessionEntry;
    extendParams.sessionKey = params.sessionKey;
    const extendResult = await handleTrustCommand(extendParams, true);

    expect(extendResult?.shouldContinue).toBe(false);
    expect(extendResult?.reply?.text).toContain("already active");
    expect(resolveTrustedExecSecurity(params.sessionEntry.sessionId)).toBe("full");
  });

  it("expires trust automatically", async () => {
    const params = buildParams("/trust 1");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };

    await handleTrustCommand(params, true);
    expect(resolveTrustedExecSecurity(params.sessionEntry.sessionId)).toBe("full");

    vi.advanceTimersByTime(60_000);
    expect(resolveTrustedExecSecurity(params.sessionEntry.sessionId)).toBeUndefined();
  });

  it("revokes trust via /untrust", async () => {
    const trustParams = buildParams("/trust 10");
    trustParams.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    await handleTrustCommand(trustParams, true);
    expect(resolveTrustedExecSecurity(trustParams.sessionEntry.sessionId)).toBe("full");

    const untrustParams = buildParams("/untrust");
    untrustParams.sessionEntry = trustParams.sessionEntry;
    untrustParams.sessionKey = trustParams.sessionKey;
    const untrustResult = await handleUntrustCommand(untrustParams, true);

    expect(untrustResult).toEqual({
      shouldContinue: false,
      reply: { text: "🔒 Trust revoked for this session" },
    });
    expect(resolveTrustedExecSecurity(trustParams.sessionEntry.sessionId)).toBeUndefined();
  });

  it("clears stale trust windows when a session rolls over and /trust is called again", async () => {
    const oldSessionParams = buildParams("/trust 10");
    oldSessionParams.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    await handleTrustCommand(oldSessionParams, true);
    expect(resolveTrustedExecSecurity("session-1")).toBe("full");

    const newSessionParams = buildParams("/trust 10");
    newSessionParams.sessionEntry = {
      sessionId: "session-2",
      updatedAt: Date.now(),
    };
    newSessionParams.sessionKey = oldSessionParams.sessionKey;

    const result = await handleTrustCommand(newSessionParams, true);

    expect(result?.shouldContinue).toBe(false);
    expect(resolveTrustedExecSecurity("session-1")).toBeUndefined();
    expect(resolveTrustedExecSecurity("session-2")).toBe("full");
  });

  it("clears stale trust windows from prior sessions on /untrust", async () => {
    const oldSessionParams = buildParams("/trust 10");
    oldSessionParams.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    await handleTrustCommand(oldSessionParams, true);
    expect(resolveTrustedExecSecurity("session-1")).toBe("full");

    const newSessionParams = buildParams("/untrust");
    newSessionParams.sessionEntry = {
      sessionId: "session-2",
      updatedAt: Date.now(),
    };
    newSessionParams.sessionKey = oldSessionParams.sessionKey;

    const result = await handleUntrustCommand(newSessionParams, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ No active trust window for this session" },
    });
    expect(resolveTrustedExecSecurity("session-1")).toBeUndefined();
    expect(resolveTrustedExecSecurity("session-2")).toBeUndefined();
  });

  it("validates trust minute bounds", async () => {
    const params = buildParams("/trust 999");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };

    const result = await handleTrustCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("between 1 and 480");
    expect(resolveTrustedExecSecurity(params.sessionEntry.sessionId)).toBeUndefined();
  });

  it("ignores unauthorized /trust commands", async () => {
    const params = buildParams("/trust 10");
    params.command.isAuthorizedSender = false;
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };

    const result = await handleTrustCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(resolveTrustedExecSecurity(params.sessionEntry.sessionId)).toBeUndefined();
  });

  it("scrubs non-integer and out-of-range numerical input", async () => {
    const cases = [
      "/trust 0",
      "/trust -5",
      "/trust 15.5",
      "/trust 481",
      "/trust abc",
      "/trust 1e5",
    ];
    for (const cmd of cases) {
      resetTrustCommandForTests();
      const params = buildParams(cmd);
      params.sessionEntry = { sessionId: "session-1", updatedAt: Date.now() };
      const result = await handleTrustCommand(params, true);
      expect(result?.shouldContinue, `${cmd} should stop`).toBe(false);
      expect(
        resolveTrustedExecSecurity(params.sessionEntry.sessionId),
        `${cmd} should not grant trust`,
      ).toBeUndefined();
    }
  });
});
