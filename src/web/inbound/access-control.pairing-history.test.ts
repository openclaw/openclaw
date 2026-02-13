import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkInboundAccessControl,
  resetPairingRequestRateLimitForTests,
} from "./access-control.js";

const sendMessageMock = vi.fn();
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();
const sendSystemNotificationToTelegramAdminMock = vi.fn();

let config: Record<string, unknown> = {};

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => config,
  };
});

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../../infra/system-notifications.js", () => ({
  sendSystemNotificationToTelegramAdmin: (...args: unknown[]) =>
    sendSystemNotificationToTelegramAdminMock(...args),
}));

beforeEach(() => {
  resetPairingRequestRateLimitForTests();
  config = {
    channels: {
      whatsapp: {
        dmPolicy: "pairing",
        allowFrom: [],
      },
    },
  };
  sendMessageMock.mockReset().mockResolvedValue(undefined);
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  sendSystemNotificationToTelegramAdminMock.mockReset().mockResolvedValue(true);
});

describe("checkInboundAccessControl", () => {
  it("suppresses pairing replies for historical DMs on connect", async () => {
    const connectedAtMs = 1_000_000;
    const messageTimestampMs = connectedAtMs - 31_000;

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      messageTimestampMs,
      connectedAtMs,
      pairingGraceMs: 30_000,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends pairing replies for live DMs", async () => {
    const connectedAtMs = 1_000_000;
    const messageTimestampMs = connectedAtMs - 10_000;

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      messageTimestampMs,
      connectedAtMs,
      pairingGraceMs: 30_000,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
    const sentPayload = sendMessageMock.mock.calls[0]?.[1] as { text?: string } | undefined;
    expect(sentPayload?.text).toContain("Pairing request recorded.");
    expect(sentPayload?.text).not.toContain("Pairing code:");
    expect(sendSystemNotificationToTelegramAdminMock).not.toHaveBeenCalled();
  });

  it("honors account-level dmPolicy overrides", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["*"],
          accounts: {
            ops: {
              dmPolicy: "disabled",
              allowFrom: ["*"],
            },
          },
        },
      },
    };

    const result = await checkInboundAccessControl({
      accountId: "ops",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      messageTimestampMs: 1_000_000,
      connectedAtMs: 1_000_000,
      pairingGraceMs: 30_000,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("rate limits pairing requests after the bounded threshold", async () => {
    upsertPairingRequestMock.mockResolvedValue({ code: "PAIRCODE", created: true });

    for (let i = 0; i < 6; i += 1) {
      await checkInboundAccessControl({
        accountId: "default",
        from: `+1555000111${i}`,
        selfE164: "+15550009999",
        senderE164: `+1555000111${i}`,
        group: false,
        pushName: "Sam",
        isFromMe: false,
        messageTimestampMs: 1_000_000,
        connectedAtMs: 1_000_000,
        pairingGraceMs: 30_000,
        sock: { sendMessage: sendMessageMock },
        remoteJid: `1555000111${i}@s.whatsapp.net`,
      });
    }

    expect(upsertPairingRequestMock).toHaveBeenCalledTimes(5);
    expect(sendMessageMock).toHaveBeenCalledTimes(5);
    expect(sendSystemNotificationToTelegramAdminMock).not.toHaveBeenCalled();
  });

  it("allows pairing requests again after the rate-limit window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-12T12:00:00.000Z"));
      upsertPairingRequestMock.mockResolvedValue({ code: "PAIRCODE", created: true });

      for (let i = 0; i < 5; i += 1) {
        await checkInboundAccessControl({
          accountId: "default",
          from: `+1555000222${i}`,
          selfE164: "+15550009999",
          senderE164: `+1555000222${i}`,
          group: false,
          pushName: "Sam",
          isFromMe: false,
          messageTimestampMs: 1_000_000,
          connectedAtMs: 1_000_000,
          pairingGraceMs: 30_000,
          sock: { sendMessage: sendMessageMock },
          remoteJid: `1555000222${i}@s.whatsapp.net`,
        });
      }

      vi.setSystemTime(new Date("2026-02-12T12:10:01.000Z"));

      await checkInboundAccessControl({
        accountId: "default",
        from: "+15550009991",
        selfE164: "+15550009999",
        senderE164: "+15550009991",
        group: false,
        pushName: "Sam",
        isFromMe: false,
        messageTimestampMs: 1_000_000,
        connectedAtMs: 1_000_000,
        pairingGraceMs: 30_000,
        sock: { sendMessage: sendMessageMock },
        remoteJid: "15550009991@s.whatsapp.net",
      });

      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(6);
      expect(sendMessageMock).toHaveBeenCalledTimes(6);
      expect(sendSystemNotificationToTelegramAdminMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
