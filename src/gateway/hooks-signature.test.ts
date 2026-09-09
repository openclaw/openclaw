import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  decodeStandardWebhooksSecret,
  normalizeHookMappingSignature,
  resolveHookPathSignature,
  verifyStandardWebhooksSignature,
} from "./hooks-signature.js";

const SECRET = `whsec_${randomBytes(32).toString("base64")}`;
const OTHER_SECRET = `whsec_${randomBytes(32).toString("base64")}`;
const BODY = JSON.stringify({
  id: "evt_1",
  type: "feed.news_item.emitted",
  data: { headline: "GPT-6" },
});
const NOW_MS = 1_800_000_000_000;

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function signedHeaders(params?: {
  id?: string;
  timestamp?: string;
  secret?: string;
  body?: string;
}) {
  const id = params?.id ?? "msg_2abc";
  const timestamp = params?.timestamp ?? String(Math.floor(NOW_MS / 1000));
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": sign(params?.secret ?? SECRET, id, timestamp, params?.body ?? BODY),
  };
}

function secrets(...values: string[]): Buffer[] {
  return values.map((value) => {
    const decoded = decodeStandardWebhooksSecret(value);
    if (!decoded) {
      throw new Error("test secret must decode");
    }
    return decoded;
  });
}

describe("verifyStandardWebhooksSignature", () => {
  test("accepts a valid signature and reports the delivery id", () => {
    const result = verifyStandardWebhooksSignature({
      headers: signedHeaders(),
      rawBody: BODY,
      secrets: secrets(SECRET),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true, deliveryId: "msg_2abc" });
  });

  test("accepts any configured secret so rotation overlaps keep verifying", () => {
    const result = verifyStandardWebhooksSignature({
      headers: signedHeaders({ secret: OTHER_SECRET }),
      rawBody: BODY,
      secrets: secrets(SECRET, OTHER_SECRET),
      nowMs: NOW_MS,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts a header carrying several space-separated signatures", () => {
    const headers = signedHeaders();
    headers["webhook-signature"] =
      `v1,${Buffer.alloc(32).toString("base64")} ${headers["webhook-signature"]}`;
    const result = verifyStandardWebhooksSignature({
      headers,
      rawBody: BODY,
      secrets: secrets(SECRET),
      nowMs: NOW_MS,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a body that differs from the signed bytes", () => {
    const result = verifyStandardWebhooksSignature({
      headers: signedHeaders(),
      rawBody: BODY.replace("GPT-6", "GPT-7"),
      secrets: secrets(SECRET),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  test("rejects a signature made with an unknown secret", () => {
    const result = verifyStandardWebhooksSignature({
      headers: signedHeaders({ secret: OTHER_SECRET }),
      rawBody: BODY,
      secrets: secrets(SECRET),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  test("rejects timestamps outside the tolerance window in both directions", () => {
    const past = String(Math.floor(NOW_MS / 1000) - 301);
    const future = String(Math.floor(NOW_MS / 1000) + 301);
    for (const timestamp of [past, future]) {
      const result = verifyStandardWebhooksSignature({
        headers: signedHeaders({ timestamp }),
        rawBody: BODY,
        secrets: secrets(SECRET),
        nowMs: NOW_MS,
      });
      expect(result).toEqual({ ok: false, reason: "timestamp-out-of-tolerance" });
    }
    const custom = verifyStandardWebhooksSignature({
      headers: signedHeaders({ timestamp: past }),
      rawBody: BODY,
      secrets: secrets(SECRET),
      toleranceSeconds: 600,
      nowMs: NOW_MS,
    });
    expect(custom.ok).toBe(true);
  });

  test("rejects malformed timestamps before touching the secret", () => {
    const result = verifyStandardWebhooksSignature({
      headers: signedHeaders({ timestamp: "17e9" }),
      rawBody: BODY,
      secrets: secrets(SECRET),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "invalid-timestamp" });
  });

  test("fails closed when any signature header is missing", () => {
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const headers = signedHeaders();
      delete headers[name as keyof typeof headers];
      const result = verifyStandardWebhooksSignature({
        headers,
        rawBody: BODY,
        secrets: secrets(SECRET),
        nowMs: NOW_MS,
      });
      expect(result).toEqual({ ok: false, reason: "missing-headers" });
    }
  });

  test("ignores signature versions other than v1", () => {
    const headers = signedHeaders();
    headers["webhook-signature"] = headers["webhook-signature"].replace("v1,", "v1a,");
    const result = verifyStandardWebhooksSignature({
      headers,
      rawBody: BODY,
      secrets: secrets(SECRET),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "unsupported-signature-version" });
  });
});

describe("decodeStandardWebhooksSecret", () => {
  test("decodes whsec_ and bare base64 secrets", () => {
    const raw = randomBytes(24);
    expect(decodeStandardWebhooksSecret(`whsec_${raw.toString("base64")}`)).toEqual(raw);
    expect(decodeStandardWebhooksSecret(raw.toString("base64"))).toEqual(raw);
  });

  test("rejects short or non-base64 secrets", () => {
    expect(decodeStandardWebhooksSecret("whsec_c2hvcnQ=")).toBeNull();
    expect(decodeStandardWebhooksSecret("whsec_not base64!")).toBeNull();
    expect(decodeStandardWebhooksSecret("")).toBeNull();
  });
});

describe("normalizeHookMappingSignature", () => {
  test("decodes one or several secrets and applies the default tolerance", () => {
    const resolved = normalizeHookMappingSignature(
      { scheme: "standard-webhooks", secret: [SECRET, OTHER_SECRET] },
      "ambush",
    );
    expect(resolved.secrets).toHaveLength(2);
    expect(resolved.toleranceSeconds).toBe(300);
  });

  test("rejects malformed secrets loudly at config load", () => {
    expect(() =>
      normalizeHookMappingSignature(
        { scheme: "standard-webhooks", secret: "whsec_short" },
        "ambush",
      ),
    ).toThrow(/whsec_-prefixed base64/);
  });
});

describe("resolveHookPathSignature", () => {
  const signature = normalizeHookMappingSignature(
    { scheme: "standard-webhooks", secret: SECRET },
    "ambush",
  );
  const mappings = [
    { id: "ambush", matchPath: "ambush", action: "agent" as const, signature },
    { id: "open", action: "agent" as const },
  ];

  test("the first path-matching mapping owns authentication", () => {
    expect(resolveHookPathSignature(mappings, "ambush")).toBe(signature);
    expect(resolveHookPathSignature(mappings, "/ambush/")).toBe(signature);
    expect(resolveHookPathSignature(mappings, "gmail")).toBeUndefined();
    expect(resolveHookPathSignature([], "ambush")).toBeUndefined();
  });
});
