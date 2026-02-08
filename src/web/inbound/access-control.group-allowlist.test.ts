import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkInboundAccessControl } from "./access-control.js";

const sendMessageMock = vi.fn();
const readAllowFromStoreMock = vi.fn();

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
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true }),
}));

const baseSock = { sendMessage: sendMessageMock };

beforeEach(() => {
  config = {};
  sendMessageMock.mockReset().mockResolvedValue(undefined);
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
});

describe("group allowlist via groups config", () => {
  it("allows group message when group JID is in groups config", async () => {
    config = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groups: {
            "approved-group@g.us": {},
          },
        },
      },
    };
    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+1234567890",
      selfE164: "+10000000000",
      senderE164: "+9999999999", // random sender, not in any allowFrom
      group: true,
      isFromMe: false,
      remoteJid: "approved-group@g.us",
      sock: baseSock,
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks group message when group JID is NOT in groups config", async () => {
    config = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groups: {
            "approved-group@g.us": {},
          },
        },
      },
    };
    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+1234567890",
      selfE164: "+10000000000",
      senderE164: "+9999999999",
      group: true,
      isFromMe: false,
      remoteJid: "spam-group@g.us",
      sock: baseSock,
    });
    expect(result.allowed).toBe(false);
  });

  it("falls back to sender-based filtering when no groups config", async () => {
    config = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+1111111111"],
        },
      },
    };
    // Sender not in groupAllowFrom → blocked
    const blocked = await checkInboundAccessControl({
      accountId: "default",
      from: "+1234567890",
      selfE164: "+10000000000",
      senderE164: "+9999999999",
      group: true,
      isFromMe: false,
      remoteJid: "some-group@g.us",
      sock: baseSock,
    });
    expect(blocked.allowed).toBe(false);

    // Sender in groupAllowFrom → allowed
    const allowed = await checkInboundAccessControl({
      accountId: "default",
      from: "+1234567890",
      selfE164: "+10000000000",
      senderE164: "+1111111111",
      group: true,
      isFromMe: false,
      remoteJid: "some-group@g.us",
      sock: baseSock,
    });
    expect(allowed.allowed).toBe(true);
  });

  it("allows any sender in an approved group (chat open, commands gated separately)", async () => {
    config = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+1111111111"], // only owner for commands
          groups: {
            "my-group@g.us": {},
          },
        },
      },
    };
    // Random participant — should be allowed to chat
    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+5555555555",
      selfE164: "+10000000000",
      senderE164: "+5555555555",
      group: true,
      isFromMe: false,
      remoteJid: "my-group@g.us",
      sock: baseSock,
    });
    expect(result.allowed).toBe(true);
  });
});
