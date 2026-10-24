import { expect, it } from "vitest";
import { normalizeCredentialPayloadForKind } from "../qa/convex-credential-broker/convex/payload_validation.js";

const BUZZ_DRIVER_PRIVATE_KEY = "01".repeat(32);
const BUZZ_SUT_PRIVATE_KEY = "02".repeat(32);
const BUZZ_DRIVER_NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";

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
    tdlibArchiveBase64: "YQ==",
    tdlibArchiveSha256: "a".repeat(64),
    tdlibVersion: "1.8.67",
    participants: [
      {
        alias: "guest",
        testerUserId: "700000003",
        tdlibArchiveBase64: "Yg==",
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

const buzz = (overrides: Record<string, unknown>) =>
  normalizeCredentialPayloadForKind("buzz", { ...buzzPayload, ...overrides });
const telegram = (overrides: Record<string, unknown>) =>
  normalizeCredentialPayloadForKind("telegram-test-userbot", {
    ...buildTelegramTestUserbotPayload(),
    ...overrides,
  });

it("allows plaintext loopback Buzz relay URLs", () => {
  const relayUrl = "ws://127.0.0.1:8080";
  expect(buzz({ relayUrl })).toMatchObject({ relayUrl });
});

it.each([
  [{ relayUrl: "ws://relay.qa.example" }, /wss:\/\//u],
  [{ sutPrivateKey: BUZZ_DRIVER_NSEC }, /distinct driver and SUT identities/u],
  [{ driverPrivateKey: "not-a-private-key" }, /nsec or 64-character hex private key/u],
  [{ driverAuthTag: "not-an-auth-tag" }, /auth tag JSON array/u],
] as const)("rejects invalid Buzz credentials: %j", (overrides, error) => {
  expect(() => buzz(overrides)).toThrow(error);
});

it("rejects malformed Buzz credential payloads without echoing values", () => {
  const privateKey = BUZZ_DRIVER_PRIVATE_KEY;
  const identities = { driverPrivateKey: privateKey, sutPrivateKey: privateKey };
  expect(() => buzz({ ...identities, relayUrl: "https://relay.qa.example/private-path" })).toThrow(
    /wss:\/\//u,
  );
  try {
    buzz(identities);
  } catch (error) {
    expect(String(error)).not.toContain(privateKey);
  }
});

it.each([
  [{ forumTopicId: 0 }, /invalid forumTopicId/u],
  [
    {
      participants: [
        { ...buildTelegramTestUserbotPayload().participants[0], testerUserId: "700000002" },
      ],
    },
    /distinct participant identities/u,
  ],
  [{ environment: "production" }, /telegram-test-userbot/u],
] as const)("rejects invalid Telegram userbot credentials: %j", (overrides, error) => {
  expect(() => telegram(overrides)).toThrow(error);
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
