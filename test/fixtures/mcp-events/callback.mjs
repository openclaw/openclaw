import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export const MAX_BODY_BYTES = 256 * 1024;
export const PROTOCOL_VERSION = "2026-07-28";
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]) {
  blocked.addSubnet(address, prefix, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signingKey(secret) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) {
    throw new Error("Expected whsec_ followed by base64 of 24–64 bytes");
  }
  const value = secret.slice(6);
  const key = Buffer.from(value, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== value) {
    throw new Error("Expected canonical base64 of 24–64 bytes");
  }
  return key;
}

export function webhookHeaders(subscription, eventId, body, options = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secrets = [subscription.secret];
  if (subscription.previousSecret && subscription.rotationUntil > Date.now()) {
    secrets.push(subscription.previousSecret);
  }
  const signatures = secrets.map(
    (secret) =>
      "v1," +
      createHmac("sha256", signingKey(secret))
        .update(eventId + "." + timestamp + "." + body)
        .digest("base64"),
  );
  return {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "webhook-id": eventId,
    "webhook-timestamp": timestamp,
    "webhook-signature": options.invalidSignature
      ? "v1," + Buffer.alloc(32).toString("base64")
      : signatures.join(" "),
    "x-mcp-subscription-id": subscription.id,
  };
}

export function callbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Callback must be HTTPS without credentials or fragment");
  }
  return url;
}

function isPublic(address) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

// Resolve once per connection and pin the checked address. TLS still authenticates
// the URL hostname; a trusted CA never disables certificate or hostname checking.
export async function postCallback(subscription, body, eventId, options = {}) {
  if (Buffer.byteLength(body) > MAX_BODY_BYTES && !options.oversizeProbe) {
    throw new Error("Event payload exceeds 256 KiB");
  }
  const url = callbackUrl(subscription.url);
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  const fixtureLoopback = options.loopbackOrigin === url.origin && options.ca;
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        !(fixtureLoopback && (address === "127.0.0.1" || address === "::1")) && !isPublic(address),
    )
  ) {
    throw new Error("Callback resolves to a non-public address");
  }
  const pinned = addresses[0];
  if (options.isActive && !options.isActive()) {
    throw new Error("Subscription is no longer active");
  }
  return await new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        agent: false,
        ca: fixtureLoopback ? options.ca : undefined,
        headers: webhookHeaders(subscription, eventId, body, options),
        lookup: (_hostname, lookupOptions, done) => {
          if (lookupOptions.all) {
            done(null, [pinned]);
          } else {
            done(null, pinned.address, pinned.family);
          }
        },
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024) {
            response.destroy(new Error("Callback response exceeds 16 KiB"));
          } else {
            chunks.push(chunk);
          }
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            retryAfter: response.headers["retry-after"],
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
