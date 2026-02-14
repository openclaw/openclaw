import { beforeEach, describe, expect, it } from "vitest";
import {
  sendMessageMock,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";

type CheckInboundAccessControl = typeof import("./access-control.js").checkInboundAccessControl;
let checkInboundAccessControl: CheckInboundAccessControl;

setupAccessControlTestHarness();

beforeEach(async () => {
  ({ checkInboundAccessControl } = await import("./access-control.js"));
});

describe("WhatsApp dmPolicy precedence", () => {
  it("uses account-level dmPolicy instead of channel-level (#8736)", async () => {
    // Channel-level says "pairing" but the account-level says "allowlist".
    // The account-level override should take precedence, so an unauthorized
    // sender should be blocked silently (no pairing reply).
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          accounts: {
            work: {
              dmPolicy: "allowlist",
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "work",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Stranger",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("inherits channel-level dmPolicy when account-level dmPolicy is unset", async () => {
    // Account has allowFrom set, but no dmPolicy override. Should inherit the channel default.
    // With dmPolicy=allowlist, unauthorized senders are silently blocked.
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "work",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Stranger",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
    });

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
