import { describe, expect, it } from "vitest";
import {
  readAllowFromStoreMock,
  sendMessageMock,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";

setupAccessControlTestHarness();

const { checkInboundAccessControl } = await import("./access-control.js");

async function checkUnauthorizedWorkDmSender() {
  return checkInboundAccessControl({
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
}

function expectSilentlyBlocked(result: { allowed: boolean }) {
  expect(result.allowed).toBe(false);
  expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  expect(sendMessageMock).not.toHaveBeenCalled();
}

describe("checkInboundAccessControl pairing grace", () => {
  async function runPairingGraceCase(messageTimestampMs: number) {
    const connectedAtMs = 1_000_000;
    return await checkInboundAccessControl({
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
  }

  it("suppresses pairing replies for historical DMs on connect", async () => {
    const result = await runPairingGraceCase(1_000_000 - 31_000);

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends pairing replies for live DMs", async () => {
    const result = await runPairingGraceCase(1_000_000 - 10_000);

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
  });
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

    const result = await checkUnauthorizedWorkDmSender();
    expectSilentlyBlocked(result);
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

    const result = await checkUnauthorizedWorkDmSender();
    expectSilentlyBlocked(result);
  });

  it("does not merge persisted pairing approvals in allowlist mode", async () => {
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
    readAllowFromStoreMock.mockResolvedValue(["+15550001111"]);

    const result = await checkUnauthorizedWorkDmSender();

    expectSilentlyBlocked(result);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("always allows same-phone DMs even when allowFrom is restrictive", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+15550001111"],
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550009999",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      group: false,
      pushName: "Owner",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550009999@s.whatsapp.net",
    });

    expect(result.allowed).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe("selfChatMode: outbound DMs to third parties (#32632)", () => {
  it("should block outbound DMs to a third party even when selfChatMode is true", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "allowlist",
          selfChatMode: true,
          allowFrom: ["+15550009999"],
        },
      },
    });
    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550009999",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      group: false,
      pushName: "Me",
      isFromMe: true,
      sock: { sendMessage: sendMessageMock },
      // Remote JID is a DIFFERENT number (third party)
      remoteJid: "15551112222@s.whatsapp.net",
    });
    expect(result.allowed).toBe(false);
    expect(result.isSelfChat).toBe(false);
  });

  it("should allow true self-chat (sender == recipient == self)", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "allowlist",
          selfChatMode: true,
          allowFrom: ["+15550009999"],
        },
      },
    });
    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550009999",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      group: false,
      pushName: "Me",
      isFromMe: true,
      sock: { sendMessage: sendMessageMock },
      // Remote JID is the SAME number (true self-chat)
      remoteJid: "15550009999@s.whatsapp.net",
    });
    expect(result.allowed).toBe(true);
    expect(result.isSelfChat).toBe(true);
  });

  it("should allow inbound DMs from allowlisted third parties", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "allowlist",
          selfChatMode: true,
          allowFrom: ["+15550009999", "+15551112222"],
        },
      },
    });
    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15551112222",
      selfE164: "+15550009999",
      senderE164: "+15551112222",
      group: false,
      pushName: "Dylan",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15551112222@s.whatsapp.net",
    });
    expect(result.allowed).toBe(true);
  });
});

describe("selfChatMode: LID-format JID handling (#32632)", () => {
  it("should block outbound DM when remoteJid is an unresolvable LID JID", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "allowlist",
          selfChatMode: true,
          allowFrom: ["+15550009999"],
        },
      },
    });
    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550009999",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      group: false,
      pushName: "Me",
      isFromMe: true,
      sock: { sendMessage: sendMessageMock },
      // LID-format JID that cannot be resolved to E164
      remoteJid: "123456789:0@lid",
    });
    expect(result.allowed).toBe(false);
    expect(result.isSelfChat).toBe(false);
  });
});
