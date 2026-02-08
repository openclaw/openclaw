import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkInboundAccessControl } from "./access-control.js";

const sendMessageMock = vi.fn();
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();

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

beforeEach(() => {
  config = {
    channels: {
      whatsapp: {
        dmPolicy: "allowlist",
        allowFrom: ["+15550009999"],
        groupPolicy: "allowlist",
      },
    },
  };
  sendMessageMock.mockReset().mockResolvedValue(undefined);
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
});

describe("checkInboundAccessControl group allowlist (#3375)", () => {
  it("allows messages from any sender when group is in groups allowlist", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550009999"],
          groupPolicy: "allowlist",
          groups: {
            "123456789@g.us": { requireMention: false },
          },
        },
      },
    };

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "123456789@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111", // Sender NOT in allowFrom
      group: true,
      groupId: "123456789@g.us",
      pushName: "Unknown User",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "123456789@g.us",
    });

    expect(result.allowed).toBe(true);
  });

  it("blocks messages when group is NOT in groups allowlist and sender NOT in groupAllowFrom", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550009999"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550009999"],
          // No groups config - so group is not in allowlist
        },
      },
    };

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "123456789@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111", // Sender NOT in groupAllowFrom
      group: true,
      groupId: "123456789@g.us",
      pushName: "Unknown User",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "123456789@g.us",
    });

    expect(result.allowed).toBe(false);
  });

  it("allows messages when sender is in groupAllowFrom even if group not in allowlist", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550009999"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111"],
        },
      },
    };

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "123456789@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111", // Sender IS in groupAllowFrom
      group: true,
      groupId: "123456789@g.us",
      pushName: "Allowed User",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "123456789@g.us",
    });

    expect(result.allowed).toBe(true);
  });

  it("blocks all group messages when groupPolicy is disabled", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550009999"],
          groupPolicy: "disabled",
        },
      },
    };

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "123456789@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: true,
      groupId: "123456789@g.us",
      pushName: "User",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "123456789@g.us",
    });

    expect(result.allowed).toBe(false);
  });

  it("blocks group messages when groupPolicy is allowlist but no groups configured and no groupAllowFrom", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550009999"],
          groupPolicy: "allowlist",
          // No groups and no groupAllowFrom
        },
      },
    };

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "123456789@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: true,
      groupId: "123456789@g.us",
      pushName: "User",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "123456789@g.us",
    });

    expect(result.allowed).toBe(false);
  });

  it("allows messages with groupAllowFrom wildcard", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550009999"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["*"],
        },
      },
    };

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "123456789@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: true,
      groupId: "123456789@g.us",
      pushName: "Any User",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "123456789@g.us",
    });

    expect(result.allowed).toBe(true);
  });
});
