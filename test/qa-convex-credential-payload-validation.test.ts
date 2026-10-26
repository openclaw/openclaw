import { expect, it } from "vitest";
import { normalizeCredentialPayloadForKind } from "../qa/convex-credential-broker/convex/payload_validation.js";

const BUZZ_DRIVER_PRIVATE_KEY = "01".repeat(32);
const BUZZ_DRIVER_NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";

const telegramUser = {
  testerUserId: "700000002",
  tdlibArchiveBase64: "YQ==",
  tdlibArchiveSha256: "a".repeat(64),
  tdlibVersion: "1.8.67",
};
const payloads = {
  buzz: {
    relayUrl: "wss://relay.qa.example",
    roomId: "123e4567-e89b-42d3-a456-426614174000",
    driverPrivateKey: BUZZ_DRIVER_PRIVATE_KEY,
    sutPrivateKey: "02".repeat(32),
  },
  "telegram-test-userbot": {
    schemaVersion: 1,
    environment: "test",
    groupId: "-1001",
    forumGroupId: "-1002",
    forumTopicId: 42,
    sutBotId: "700000001",
    ...telegramUser,
  },
  whatsapp: {
    driverPhoneE164: "+15550000001",
    sutPhoneE164: "+15550000001",
  },
};

it("allows plaintext loopback Buzz relay URLs", () => {
  const relayUrl = "ws://127.0.0.1:8080";
  expect(normalizeCredentialPayloadForKind("buzz", { ...payloads.buzz, relayUrl })).toMatchObject({
    relayUrl,
  });
});

it.each([
  ["buzz", { relayUrl: "ws://relay.qa.example" }, /wss:\/\//u],
  [
    "buzz",
    { relayUrl: "https://relay.qa.example/private-path", sutPrivateKey: BUZZ_DRIVER_PRIVATE_KEY },
    /wss:\/\//u,
  ],
  ["buzz", { sutPrivateKey: BUZZ_DRIVER_NSEC }, /distinct driver and SUT identities/u],
  ["buzz", { sutPrivateKey: BUZZ_DRIVER_PRIVATE_KEY }, /distinct driver and SUT identities/u],
  ["buzz", { driverPrivateKey: "not-a-private-key" }, /nsec or 64-character hex private key/u],
  ["buzz", { driverAuthTag: "not-an-auth-tag" }, /auth tag JSON array/u],
  ["telegram-test-userbot", { forumTopicId: 0 }, /invalid forumTopicId/u],
  [
    "telegram-test-userbot",
    { participants: [{ ...telegramUser, alias: "guest" }] },
    /distinct participant identities/u,
  ],
  ["telegram-test-userbot", { environment: "production" }, /telegram-test-userbot/u],
  ["whatsapp", {}, /distinct driverPhoneE164 and sutPhoneE164/u],
] as const)("rejects invalid %s credentials: %j", (kind, overrides, error) => {
  const normalize = () =>
    normalizeCredentialPayloadForKind(kind, { ...payloads[kind], ...overrides });
  expect(normalize).toThrow(error);
  expect(normalize).not.toThrow(BUZZ_DRIVER_PRIVATE_KEY);
});
