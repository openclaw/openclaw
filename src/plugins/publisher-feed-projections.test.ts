import crypto, { type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE,
  PUBLISHER_FEED_QUERY_PAYLOAD_TYPE,
  PUBLISHER_FEED_SNAPSHOT_PAYLOAD_TYPE,
  verifyPublisherFeedProjection,
} from "./publisher-feed-projections.js";

type SigningKey = { keyId: string; privateKey: KeyObject; publicKey: KeyObject };

function signingKey(): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { keyId: "clawhub-feed-2026-q3", privateKey, publicKey };
}

function signedEnvelope(key: SigningKey, payloadType: string, payload: unknown) {
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const typeBytes = Buffer.from(payloadType);
  const signingInput = Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} ${payloadType} ${payloadBytes.length} `),
    payloadBytes,
  ]);
  return {
    payloadType,
    payload: payloadBytes.toString("base64url"),
    signatures: [
      {
        keyid: key.keyId,
        sig: crypto.sign(null, signingInput, key.privateKey).toString("base64url"),
      },
    ],
  };
}

function verification(key: SigningKey) {
  return {
    trustedKeys: [
      {
        keyId: key.keyId,
        publicKey: key.publicKey.export({ type: "spki", format: "pem" }),
      },
    ],
  };
}

const entry = {
  kind: "skill",
  id: "skills:cuda",
  name: "cuda-helper",
  displayName: "CUDA Helper",
  summary: "GPU tools",
  url: "/alice/skills/cuda-helper",
  updatedAt: 2,
};

const projectionBase = {
  schemaVersion: 1,
  feedId: "clawhub.publisher.publishers:alice",
  generatedAt: "2026-07-16T00:00:00.000Z",
  expiresAt: "2026-07-16T00:05:00.000Z",
};

describe("publisher feed signed projections", () => {
  it("verifies a complete signed publisher snapshot with distinct authority", () => {
    const key = signingKey();
    const payload = {
      ...projectionBase,
      publisherId: "publishers:alice",
      handle: "alice",
      displayName: "Alice",
      sequence: 7,
      entries: [entry],
    };
    expect(
      verifyPublisherFeedProjection(
        signedEnvelope(key, PUBLISHER_FEED_SNAPSHOT_PAYLOAD_TYPE, payload),
        { payloadType: PUBLISHER_FEED_SNAPSHOT_PAYLOAD_TYPE, ...verification(key) },
      ),
    ).toMatchObject({ payload, signedBy: key.keyId });
    expect(() =>
      verifyPublisherFeedProjection(
        signedEnvelope(key, PUBLISHER_FEED_SNAPSHOT_PAYLOAD_TYPE, {
          ...payload,
          entries: [entry, entry],
        }),
        { payloadType: PUBLISHER_FEED_SNAPSHOT_PAYLOAD_TYPE, ...verification(key) },
      ),
    ).toThrow("projection payload is invalid");
  });

  it("verifies a strict signed query page without treating it as an install catalog", () => {
    const key = signingKey();
    const payload = {
      ...projectionBase,
      sequence: 7,
      query: { text: "CUDA Helper", kinds: ["skill"] },
      requestCursor: null,
      pageIndex: 0,
      startIndex: 0,
      resultCount: 1,
      entries: [entry],
      nextCursor: null,
    };
    const result = verifyPublisherFeedProjection(
      signedEnvelope(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, payload),
      { payloadType: PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, ...verification(key) },
    );

    expect(result).toMatchObject({
      payload,
      signedBy: key.keyId,
      signatureCount: 1,
      threshold: 1,
    });
  });

  it("verifies complete change pages and reset-required responses", () => {
    const key = signingKey();
    const changes = {
      ...projectionBase,
      fromSequence: 7,
      toSequence: 8,
      requestCursor: null,
      pageIndex: 0,
      startIndex: 0,
      changeCount: 1,
      changes: [
        {
          sequence: 8,
          operation: "remove",
          entryId: "skills:old",
          entryKind: "skill",
        },
      ],
      nextCursor: null,
    };
    const reset = {
      ...projectionBase,
      fromSequence: 1,
      currentSequence: 8,
      resetRequired: true,
      snapshotUrl: "https://clawhub.ai/api/v1/publishers/publishers%3Aalice/feed/snapshot",
    };

    expect(
      verifyPublisherFeedProjection(
        signedEnvelope(key, PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE, changes),
        { payloadType: PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE, ...verification(key) },
      ).payload,
    ).toEqual(changes);
    expect(
      verifyPublisherFeedProjection(
        signedEnvelope(key, PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE, reset),
        { payloadType: PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE, ...verification(key) },
      ).payload,
    ).toEqual(reset);
  });

  it("rejects payload type confusion before parsing", () => {
    const key = signingKey();
    expect(() =>
      verifyPublisherFeedProjection(signedEnvelope(key, PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE, {}), {
        payloadType: PUBLISHER_FEED_QUERY_PAYLOAD_TYPE,
        ...verification(key),
      }),
    ).toThrow("payload type is unsupported");
  });

  it.each([
    { query: { text: " CUDA" }, reason: "non-normalized query" },
    { query: { kinds: ["skill", "skill"] }, reason: "duplicate query kinds" },
    { unexpected: true, reason: "unknown page fields" },
    { entries: [{ ...entry, url: "//evil.example/skill" }], reason: "unsafe entry URL" },
  ])("rejects $reason", ({ reason: _reason, ...override }) => {
    const key = signingKey();
    const payload = {
      ...projectionBase,
      sequence: 7,
      query: { text: "CUDA" },
      requestCursor: null,
      pageIndex: 0,
      startIndex: 0,
      resultCount: 1,
      entries: [entry],
      nextCursor: null,
      ...override,
    };
    expect(() =>
      verifyPublisherFeedProjection(
        signedEnvelope(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, payload),
        { payloadType: PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, ...verification(key) },
      ),
    ).toThrow("projection payload is invalid");
  });
});
