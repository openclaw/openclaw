import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import webPush from "web-push";
import { prepareWebPushNotificationSender } from "./push-web.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

it("reuses audience signatures across senders while encrypting each message independently", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-web-wire-"));
  cleanup.push(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = webPush.generateVAPIDKeys();
  vi.stubEnv("OPENCLAW_VAPID_PUBLIC_KEY", identity.publicKey);
  vi.stubEnv("OPENCLAW_VAPID_PRIVATE_KEY", identity.privateKey);
  vi.stubEnv("OPENCLAW_VAPID_SUBJECT", "mailto:synthetic@example.com");
  const receiver = crypto.createECDH("prime256v1");
  receiver.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = {
    subscriptionId: "synthetic",
    endpoint: "https://push.example.com/synthetic",
    keys: {
      p256dh: receiver.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  const payload = {
    title: "Approval required",
    body: "An agent needs your approval.",
    url: "/approve/synthetic",
  };
  const requests: webPush.RequestDetails[] = [];
  vi.spyOn(webPush, "sendNotification").mockImplementation(async (target, body, options) => {
    const request =
      typeof body === "string" || Buffer.isBuffer(body)
        ? webPush.generateRequestDetails(target, body, options)
        : webPush.generateRequestDetails(target, null, options);
    requests.push(request);
    return { statusCode: 201, body: "", headers: {} };
  });
  const sign = vi.spyOn(crypto.Sign.prototype, "sign");
  const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const now = vi.spyOn(Date, "now").mockReturnValue(hourStart);
  const send = await prepareWebPushNotificationSender(stateDir);
  const deliveryOptions = { TTL: 60, urgency: "high" as const, timeout: 10_000, topic: "approval" };
  await send({
    subscriptions: Array.from({ length: 16 }, () => subscription),
    payload,
    deliveryOptions,
  });
  const nextSender = await prepareWebPushNotificationSender(stateDir);
  await nextSender({ subscriptions: [subscription], payload, deliveryOptions });
  expect(requests).toHaveLength(17);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(new Set(requests.map((request) => request.headers.Authorization)).size).toBe(1);
  expect(
    new Set(requests.map((request) => request.body?.subarray(0, 16).toString("hex"))).size,
  ).toBe(17);
  expect(
    new Set(requests.map((request) => request.body?.subarray(21, 86).toString("hex"))).size,
  ).toBe(17);
  for (const request of requests) {
    expect(request.headers).toMatchObject({
      "Content-Encoding": "aes128gcm",
      TTL: 60,
      Urgency: "high",
      Topic: "approval",
    });
    const encrypted = request.body!;
    expect(encrypted.readUInt32BE(16)).toBe(4096);
    expect(encrypted[20]).toBe(65);
    const senderPublic = encrypted.subarray(21, 86);
    const secret = receiver.computeSecret(senderPublic);
    const ikm = crypto.hkdfSync(
      "sha256",
      secret,
      auth,
      Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), senderPublic]),
      32,
    );
    const salt = encrypted.subarray(0, 16);
    const key = crypto.hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0"),
      16,
    );
    const nonce = crypto.hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: nonce\0"),
      12,
    );
    const decipher = crypto.createDecipheriv("aes-128-gcm", Buffer.from(key), Buffer.from(nonce));
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(86, -16)),
      decipher.final(),
    ]);
    expect(plaintext.at(-1)).toBe(2);
    expect(JSON.parse(plaintext.subarray(0, -1).toString())).toEqual(payload);
    const token = request.headers.Authorization!.split("t=")[1]!.split(",")[0]!;
    const [header, claims, signature] = token.split(".");
    const publicBytes = Buffer.from(identity.publicKey, "base64url");
    const publicKey = crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: publicBytes.subarray(1, 33).toString("base64url"),
        y: publicBytes.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      aud: "https://push.example.com",
      sub: "mailto:synthetic@example.com",
      exp: hourStart / 1000 + 43_200,
    });
  }
  await send({
    subscriptions: [{ ...subscription, endpoint: "https://other.example.com/push" }],
    payload,
  });
  expect(sign).toHaveBeenCalledTimes(2);
  now.mockReturnValue(hourStart + 3_600_000);
  await send({ subscriptions: [subscription], payload });
  expect(sign).toHaveBeenCalledTimes(3);
  vi.stubEnv("OPENCLAW_VAPID_SUBJECT", "mailto:changed@example.com");
  const changed = await prepareWebPushNotificationSender(stateDir);
  await changed({ subscriptions: [subscription], payload });
  expect(sign).toHaveBeenCalledTimes(4);
  await send({ subscriptions: [subscription], payload });
  expect(sign).toHaveBeenCalledTimes(4);
  const rotated = webPush.generateVAPIDKeys();
  vi.stubEnv("OPENCLAW_VAPID_PUBLIC_KEY", rotated.publicKey);
  vi.stubEnv("OPENCLAW_VAPID_PRIVATE_KEY", rotated.privateKey);
  await (
    await prepareWebPushNotificationSender(stateDir)
  )({ subscriptions: [subscription], payload });
  expect(sign).toHaveBeenCalledTimes(5);
});
