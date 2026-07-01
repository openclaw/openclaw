// Tests setup short-code issue and one-time redemption.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginStateStoreForTests,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
  })),
}));

const {
  formatPairingSetupShortCode,
  issuePairingSetupShortCode,
  normalizePairingSetupShortCodeInput,
  registerPairingSetupShortCode,
  redeemPairingSetupShortCode,
} = await import("./setup-short-code.js");

const gatewayConfig = {
  gateway: {
    bind: "custom",
    customBindHost: "127.0.0.1",
    port: 19001,
    auth: { mode: "token", token: "tok_123" },
  },
} as const;

beforeEach(() => {
  vi.useRealTimers();
  clearPluginStateStoreForTests();
});

describe("pairing setup short code", () => {
  it("issues a short code that redeems once into the setup payload", async () => {
    await withOpenClawTestState({ label: "setup-short-code" }, async () => {
      vi.setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
      const issued = await issuePairingSetupShortCode(gatewayConfig, {
        codeGenerator: () => "ABCD2345",
      });

      expect(issued).toEqual({
        ok: true,
        code: "ABCD2345",
        expiresAtMs: Date.parse("2026-06-30T12:05:00.000Z"),
        authLabel: "token",
        urlSource: "gateway.bind=custom",
      });
      expect(redeemPairingSetupShortCode("abcd-2345")).toEqual({
        ok: true,
        payload: {
          url: "ws://127.0.0.1:19001",
          bootstrapToken: "bootstrap-123",
        },
        expiresAtMs: Date.parse("2026-06-30T12:05:00.000Z"),
      });
      expect(redeemPairingSetupShortCode("ABCD2345")).toEqual({
        ok: false,
        reason: "invalid_or_expired",
      });
    });
  });

  it("treats expired short codes as invalid without returning the payload", async () => {
    await withOpenClawTestState({ label: "setup-short-code-expired" }, async () => {
      vi.setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
      await issuePairingSetupShortCode(gatewayConfig, {
        ttlMs: 1_000,
        codeGenerator: () => "EFGH2345",
      });

      vi.setSystemTime(new Date("2026-06-30T12:00:01.001Z"));
      expect(redeemPairingSetupShortCode("EFGH2345")).toEqual({
        ok: false,
        reason: "invalid_or_expired",
      });
    });
  });

  it("normalizes grouped human input and rejects ambiguous characters", () => {
    expect(normalizePairingSetupShortCodeInput("abcd-2345")).toBe("ABCD2345");
    expect(normalizePairingSetupShortCodeInput("ABCD 2345")).toBe("ABCD2345");
    expect(normalizePairingSetupShortCodeInput("ABCD1045")).toBeUndefined();
    expect(formatPairingSetupShortCode("abcd2345")).toBe("ABCD-2345");
  });

  it("registers an already-issued setup payload without minting a replacement", async () => {
    await withOpenClawTestState({ label: "setup-short-code-register" }, async () => {
      vi.setSystemTime(new Date("2026-06-30T12:00:00.000Z"));

      expect(
        registerPairingSetupShortCode(
          {
            payload: {
              url: "wss://gateway.example.com",
              bootstrapToken: "existing-bootstrap",
            },
            authLabel: "token",
            urlSource: "test",
          },
          { codeGenerator: () => "JKLM2345" },
        ),
      ).toEqual({
        ok: true,
        code: "JKLM2345",
        expiresAtMs: Date.parse("2026-06-30T12:05:00.000Z"),
        authLabel: "token",
        urlSource: "test",
      });
      expect(redeemPairingSetupShortCode("JKLM-2345")).toEqual({
        ok: true,
        payload: {
          url: "wss://gateway.example.com",
          bootstrapToken: "existing-bootstrap",
        },
        expiresAtMs: Date.parse("2026-06-30T12:05:00.000Z"),
      });
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});
