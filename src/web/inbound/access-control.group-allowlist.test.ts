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

const baseGroupParams = {
  accountId: "default",
  from: "+15550001111",
  selfE164: "+15550009999",
  senderE164: "+15550001111",
  group: true,
  pushName: "Sam",
  isFromMe: false,
  sock: { sendMessage: sendMessageMock },
  remoteJid: "120363406578563291@g.us",
};

beforeEach(() => {
  config = {
    channels: {
      whatsapp: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
      },
    },
  };
  sendMessageMock.mockReset().mockResolvedValue(undefined);
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
});

describe("checkInboundAccessControl — group allowlist", () => {
  it("blocks group messages when groupPolicy is allowlist and no allowFrom exists", async () => {
    const result = await checkInboundAccessControl(baseGroupParams);
    expect(result.allowed).toBe(false);
  });

  it("allows group messages when sender is in explicit groupAllowFrom", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111"],
        },
      },
    };
    const result = await checkInboundAccessControl(baseGroupParams);
    expect(result.allowed).toBe(true);
  });

  it("allows group messages when sender is paired (in store) with groupPolicy allowlist", async () => {
    // Sender was paired via DM — their number is in the pairing store
    readAllowFromStoreMock.mockResolvedValue(["+15550001111"]);

    const result = await checkInboundAccessControl(baseGroupParams);
    expect(result.allowed).toBe(true);
  });

  it("blocks group messages from unknown sender even with paired users", async () => {
    // A different user was paired, not the group sender
    readAllowFromStoreMock.mockResolvedValue(["+15550002222"]);

    const result = await checkInboundAccessControl(baseGroupParams);
    expect(result.allowed).toBe(false);
  });

  it("allows group messages when sender is in configured allowFrom (fallback)", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+15550001111"],
          groupPolicy: "allowlist",
        },
      },
    };
    const result = await checkInboundAccessControl(baseGroupParams);
    expect(result.allowed).toBe(true);
  });

  it("allows all group messages when groupPolicy is open", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "open",
        },
      },
    };
    const result = await checkInboundAccessControl(baseGroupParams);
    expect(result.allowed).toBe(true);
  });

  it("blocks all group messages when groupPolicy is disabled", async () => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "disabled",
        },
      },
    };
    const result = await checkInboundAccessControl(baseGroupParams);
    expect(result.allowed).toBe(false);
  });
});
