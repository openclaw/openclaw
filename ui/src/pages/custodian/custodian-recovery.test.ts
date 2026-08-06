/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCustodianRecoveryForClient,
  readCustodianRecoveryForClient,
  reconcileCustodianRecoveryForClient,
} from "./custodian-recovery.ts";

const gatewayUrl = "ws://127.0.0.1:18789";
const recoveryScope = "principal-a";
const client = { recoveryScope, recoveryScopeReady: true } as never;

function remember(sessionId: string): void {
  reconcileCustodianRecoveryForClient(
    client,
    gatewayUrl,
    {
      sessionId,
      reply: "Enter a secret",
      action: "none",
      wizardInputPending: true,
      step: { id: "secret", type: "text", message: "Secret", sensitive: true },
    },
    sessionId,
  );
}

describe("Custodian wizard reload recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("stores only the active session handle in tab-scoped storage", () => {
    remember("custodian-live");
    expect(readCustodianRecoveryForClient(client, gatewayUrl)).toEqual({
      sessionId: "custodian-live",
    });
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.key(index))).toEqual([
      `openclaw.custodian.recovery.v1:${gatewayUrl}:${recoveryScope}`,
    ]);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(
      JSON.stringify({ sessionId: "custodian-live" }),
    );
  });

  it("rejects malformed state and clears only the expected session", () => {
    sessionStorage.setItem(
      `openclaw.custodian.recovery.v1:${gatewayUrl}:${recoveryScope}`,
      JSON.stringify({ sessionId: "", draft: "secret" }),
    );
    expect(readCustodianRecoveryForClient(client, gatewayUrl)).toBeNull();

    remember("custodian-live");
    clearCustodianRecoveryForClient(client, gatewayUrl, "different-session");
    expect(readCustodianRecoveryForClient(client, gatewayUrl)).not.toBeNull();
    clearCustodianRecoveryForClient(client, gatewayUrl, "custodian-live");
    expect(readCustodianRecoveryForClient(client, gatewayUrl)).toBeNull();
  });

  it("degrades cleanly when session storage access is denied", () => {
    const getItem = vi.fn(() => {
      throw new Error("storage denied");
    });
    const removeItem = vi.fn(() => {
      throw new Error("storage denied");
    });
    vi.stubGlobal("sessionStorage", { getItem, removeItem });

    expect(() => readCustodianRecoveryForClient(client, gatewayUrl)).not.toThrow();
    expect(getItem).toHaveBeenCalledOnce();
  });
});
