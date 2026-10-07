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
const discordPayload = {
  guildId: "1496962067029299350",
  channelId: "1496962068027281447",
  driverBotToken: "driver-token",
  sutBotToken: "sut-token",
  sutApplicationId: "1496963665587601428",
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
  it("normalizes Buzz credential payloads", () => {
    expect(
      normalizeCredentialPayloadForKind("buzz", {
        ...buzzPayload,
        relayUrl: " wss://relay.qa.example ",
        roomId: " 123E4567-E89B-42D3-A456-426614174000 ",
        driverPrivateKey: ` ${BUZZ_DRIVER_PRIVATE_KEY} `,
        sutPrivateKey: ` ${BUZZ_SUT_PRIVATE_KEY} `,
        driverAuthTag: ' ["auth","driver","conditions","signature"] ',
        ignored: true,
      }),
    ).toEqual({
      ...buzzPayload,
      driverAuthTag: '["auth","driver","conditions","signature"]',
    });
  });

  it.each(["ws://localhost:8080", "ws://127.0.0.1:8080", "ws://[::1]:8080"])(
    "allows plaintext loopback Buzz relay URL %s",
    (relayUrl) => {
      expect(
        normalizeCredentialPayloadForKind("buzz", {
          ...buzzPayload,
          relayUrl,
        }),
      ).toMatchObject({ relayUrl });
    },
  );

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

  it("normalizes Discord credential payloads", () => {
    expect(
      normalizeCredentialPayloadForKind("discord", {
        ...discordPayload,
        guildId: " 1496962067029299350 ",
        voiceChannelId: "1496962069025263624",
        driverBotToken: " driver-token ",
        ignored: true,
      }),
    ).toEqual({
      ...discordPayload,
      voiceChannelId: "1496962069025263624",
    });
  });

  it("rejects malformed Discord snowflakes", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("discord", {
        ...discordPayload,
        guildId: "not-a-snowflake",
      }),
    ).toThrow(/Discord snowflake/u);
  });

  it("rejects empty Discord bot tokens", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("discord", {
        ...discordPayload,
        driverBotToken: " ",
      }),
    ).toThrow(/driverBotToken/u);
  });

  it("rejects malformed optional Discord voice channel ids", () => {
    expect(() =>
      normalizeCredentialPayloadForKind("discord", {
        ...discordPayload,
        voiceChannelId: "voice-channel",
      }),
    ).toThrow(/voiceChannelId/u);
  });

  it("keeps unknown credential kinds pass-through-compatible", () => {
    const payload = { anything: true };

    expect(normalizeCredentialPayloadForKind("future-kind", payload)).toBe(payload);
  });

  it("normalizes Telegram Test Server userbot credentials", () => {
    expect(
      normalizeCredentialPayloadForKind("telegram-test-userbot", {
        ...telegramPayload,
        groupId: " -100123 ",
        sutToken: " test-token ",
        sutUsername: " @test_bot ",
        sutBotId: " 123 ",
        testerUserId: " 456 ",
        tdlibArchiveSha256: "A".repeat(64),
        tdlibVersion: " 1.8.67 ",
        ignored: true,
      }),
    ).toEqual(telegramPayload);
  });

  it("retains a validated Telegram forum topic and distinct participant sessions", () => {
    const normalized = normalizeCredentialPayloadForKind(
      "telegram-test-userbot",
      buildTelegramTestUserbotPayload(),
    );

    expect({
      forumGroupId: normalized.forumGroupId,
      forumTopicId: normalized.forumTopicId,
      participants: normalized.participants,
    }).toEqual({
      forumGroupId: "-1002",
      forumTopicId: 42,
      participants: [
        {
          alias: "guest",
          testerUserId: "700000003",
          tdlibArchiveBase64: TELEGRAM_GUEST_ARCHIVE,
          tdlibArchiveSha256: "b".repeat(64),
          tdlibVersion: "1.8.67",
        },
      ],
    });
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

  it.each([
    ["environment", { environment: "production" }],
    ["bot identity", { sutBotId: "bot" }],
    ["archive encoding", { tdlibArchiveBase64: "not-base64" }],
    ["archive hash", { tdlibArchiveSha256: "not-a-hash" }],
  ])("rejects malformed Telegram Test Server userbot %s", (_label, patch) => {
    expect(() =>
      normalizeCredentialPayloadForKind("telegram-test-userbot", {
        ...telegramPayload,
        ...patch,
      }),
    ).toThrow(/telegram-test-userbot/u);
  });

  it("normalizes WhatsApp credential payloads", () => {
    expect(
      normalizeCredentialPayloadForKind("whatsapp", {
        driverPhoneE164: "+15550000001",
        sutPhoneE164: "+15550000002",
        driverAuthArchiveBase64: "driver-archive",
        sutAuthArchiveBase64: "sut-archive",
        groupJid: "120363000000000000@g.us",
      }),
    ).toEqual({
      driverPhoneE164: "+15550000001",
      sutPhoneE164: "+15550000002",
      driverAuthArchiveBase64: "driver-archive",
      sutAuthArchiveBase64: "sut-archive",
      groupJid: "120363000000000000@g.us",
    });
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
