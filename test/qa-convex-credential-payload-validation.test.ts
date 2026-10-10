// QA Convex credential tests validate credential payload shapes.
import { describe, expect, it } from "vitest";
import { normalizeCredentialPayloadForKind } from "../qa/convex-credential-broker/convex/payload_validation.js";

const BUZZ_DRIVER_PRIVATE_KEY = "01".repeat(32);
const BUZZ_SUT_PRIVATE_KEY = "02".repeat(32);
const BUZZ_DRIVER_NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";
const TELEGRAM_PRIMARY_ARCHIVE = "YQ==";
const TELEGRAM_GUEST_ARCHIVE = "Yg==";

function buildTelegramTestUserbotPayload() {
  return {
    schemaVersion: 1,
    environment: "test",
    groupId: "-1001",
    forumGroupId: "-1002",
    forumTopicId: 42,
    sutToken: "test-token",
    sutUsername: "test_bot",
    sutBotId: "700000001",
    testerUserId: "700000002",
    tdlibArchiveBase64: TELEGRAM_PRIMARY_ARCHIVE,
    tdlibArchiveSha256: "a".repeat(64),
    tdlibVersion: "1.8.67",
    participants: [
      {
        alias: "guest",
        testerUserId: "700000003",
        tdlibArchiveBase64: TELEGRAM_GUEST_ARCHIVE,
        tdlibArchiveSha256: "b".repeat(64),
        tdlibVersion: "1.8.67",
      },
    ],
  };
}

const buzzPayload = {
  relayUrl: "wss://relay.qa.example",
  roomId: "123e4567-e89b-42d3-a456-426614174000",
  driverPrivateKey: BUZZ_DRIVER_PRIVATE_KEY,
  sutPrivateKey: BUZZ_SUT_PRIVATE_KEY,
};

const telegramPayload = {
  schemaVersion: 1,
  environment: "test",
  groupId: "-100123",
  sutToken: "test-token",
  sutUsername: "test_bot",
  sutBotId: "123",
  testerUserId: "456",
  tdlibArchiveBase64: "dGVzdA==",
  tdlibArchiveSha256: "a".repeat(64),
  tdlibVersion: "1.8.67",
};

describe("QA Convex credential payload validation", () => {
  it("allows plaintext loopback Buzz relay URLs", () => {
    const relayUrl = "ws://127.0.0.1:8080";
    expect(
      normalizeCredentialPayloadForKind("buzz", {
        ...buzzPayload,
        relayUrl,
      }),
    ).toMatchObject({ relayUrl });
  });

  it("rejects plaintext remote Buzz relay URLs", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        ...buzzPayload,
        relayUrl: "ws://relay.qa.example",
      }),
    ).toThrow(/wss:\/\//u);
  });

  it("rejects malformed Buzz credential payloads without echoing values", () => {
    const privateKey = BUZZ_DRIVER_PRIVATE_KEY;
    const invalidRelay = "https://relay.qa.example/private-path";
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        ...buzzPayload,
        relayUrl: invalidRelay,
        driverPrivateKey: privateKey,
        sutPrivateKey: privateKey,
      }),
    ).toThrow(/wss:\/\//u);
    try {
      normalizeCredentialPayloadForKind("buzz", {
        ...buzzPayload,
        driverPrivateKey: privateKey,
        sutPrivateKey: privateKey,
      });
    } catch (error) {
      expect(String(error)).not.toContain(privateKey);
    }
  });

  it("rejects runtime-invalid Buzz secrets and equivalent key encodings", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        ...buzzPayload,
        sutPrivateKey: BUZZ_DRIVER_NSEC,
      }),
    ).toThrow(/distinct driver and SUT identities/u);
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        ...buzzPayload,
        driverPrivateKey: "not-a-private-key",
      }),
    ).toThrow(/nsec or 64-character hex private key/u);
    expect(() =>
      normalizeCredentialPayloadForKind("buzz", {
        ...buzzPayload,
        driverAuthTag: "not-an-auth-tag",
      }),
    ).toThrow(/auth tag JSON array/u);
  });

  it("rejects invalid Telegram forum selectors and duplicate participant authority", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("telegram-test-userbot", {
        ...buildTelegramTestUserbotPayload(),
        forumTopicId: 0,
      }),
    ).toThrow(/invalid forumTopicId/u);
    expect(() =>
      normalizeCredentialPayloadForKind("telegram-test-userbot", {
        ...buildTelegramTestUserbotPayload(),
        participants: [
          {
            ...buildTelegramTestUserbotPayload().participants[0],
            testerUserId: "700000002",
          },
        ],
      }),
    ).toThrow(/distinct participant identities/u);
  });

  it("rejects production Telegram Test Server userbot credentials", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("telegram-test-userbot", {
        ...telegramPayload,
        environment: "production",
      }),
    ).toThrow(/telegram-test-userbot/u);
  });

  it("rejects WhatsApp payloads with duplicate phone numbers", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("whatsapp", {
        driverPhoneE164: "+15550000001",
        sutPhoneE164: "+15550000001",
        driverAuthArchiveBase64: "driver-archive",
        sutAuthArchiveBase64: "sut-archive",
      }),
    ).toThrow("distinct driverPhoneE164 and sutPhoneE164");
  });
});
