import { beforeEach, describe, expect, it } from "vitest";
import {
  sendMessageMock,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";

type CheckInboundAccessControl = typeof import("./access-control.js").checkInboundAccessControl;
let checkInboundAccessControl: CheckInboundAccessControl;

setupAccessControlTestHarness();

beforeEach(async () => {
  ({ checkInboundAccessControl } = await import("./access-control.js"));
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
  });
});
