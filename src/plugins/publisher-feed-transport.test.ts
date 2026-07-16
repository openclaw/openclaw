import crypto, { type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  guardedFetch: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: transportMocks.guardedFetch,
}));

import {
  PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE,
  PUBLISHER_FEED_QUERY_PAYLOAD_TYPE,
} from "./publisher-feed-projections.js";
import {
  applyPublisherFeedChanges,
  fetchPublisherFeedChanges,
  fetchPublisherFeedQuery,
} from "./publisher-feed-transport.js";

type SigningKey = { keyId: string; privateKey: KeyObject; publicKey: KeyObject };
type QueuedResponse = { response: Response; finalUrl?: string };

const queuedResponses: QueuedResponse[] = [];
const release = vi.fn(async () => undefined);

function signingKey(): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { keyId: "clawhub-feed-2026-q3", privateKey, publicKey };
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

function signedEnvelope(key: SigningKey, payloadType: string, payload: unknown) {
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const typeBytes = Buffer.from(payloadType);
  const signingInput = Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} ${payloadType} ${payloadBytes.length} `),
    payloadBytes,
  ]);
  return JSON.stringify({
    schemaVersion: 1,
    payloadType,
    payload: payloadBytes.toString("base64url"),
    signatures: [
      {
        keyId: key.keyId,
        algorithm: "ed25519",
        signature: crypto.sign(null, signingInput, key.privateKey).toString("base64url"),
      },
    ],
  });
}

function enqueueSigned(
  key: SigningKey,
  payloadType: string,
  payload: unknown,
  status = 200,
  headers?: HeadersInit,
) {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/vnd.dsse+json; charset=utf-8");
  }
  queuedResponses.push({
    response: new Response(signedEnvelope(key, payloadType, payload), {
      status,
      headers: responseHeaders,
    }),
  });
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

const base = {
  schemaVersion: 1,
  feedId: "clawhub.publisher.publishers:alice",
  generatedAt: "2026-07-16T00:00:00.000Z",
  expiresAt: "2026-07-16T00:05:00.000Z",
};

beforeEach(() => {
  queuedResponses.length = 0;
  release.mockClear();
  transportMocks.guardedFetch.mockReset();
  transportMocks.guardedFetch.mockImplementation(async ({ url }: { url: string }) => {
    const queued = queuedResponses.shift();
    if (!queued) {
      throw new Error("missing queued publisher feed response");
    }
    return {
      response: queued.response,
      finalUrl: queued.finalUrl ?? url,
      release,
    };
  });
});

describe("publisher feed projection transport", () => {
  it("assembles a complete signed query across revision-bound pages", async () => {
    const key = signingKey();
    const query = { text: "CUDA Helper", kinds: ["skill"] };
    enqueueSigned(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, {
      ...base,
      sequence: 7,
      query: { kinds: ["skill"], text: "CUDA Helper" },
      requestCursor: null,
      pageIndex: 0,
      startIndex: 0,
      resultCount: 2,
      entries: [entry],
      nextCursor: "",
    });
    enqueueSigned(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, {
      ...base,
      sequence: 7,
      query,
      requestCursor: "",
      pageIndex: 1,
      startIndex: 1,
      resultCount: 2,
      entries: [{ ...entry, id: "skills:cuda-two", name: "cuda-two" }],
      nextCursor: null,
    });

    const result = await fetchPublisherFeedQuery({
      baseUrl: "https://clawhub.ai",
      publisherId: "publishers:alice",
      verification: verification(key),
      query: { text: "  CUDA\tHelper ", kinds: ["skill", "skill"] },
      limit: 1,
      now: () => new Date("2026-07-16T00:01:00.000Z"),
    });

    expect(result).toMatchObject({ sequence: 7, query });
    expect(result.entries[0]).toMatchObject({ id: "skills:cuda" });
    expect(result.entries).toHaveLength(2);
    expect(transportMocks.guardedFetch.mock.calls.map(([args]) => args.url)).toEqual([
      "https://clawhub.ai/api/v1/publishers/publishers%3Aalice/feed/query?q=CUDA+Helper&kind=skill&limit=1",
      "https://clawhub.ai/api/v1/publishers/publishers%3Aalice/feed/query?cursor=",
    ]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "revision drift",
      second: { sequence: 8, requestCursor: "next", pageIndex: 1, startIndex: 1 },
      error: "revision changed",
    },
    {
      name: "cursor replay",
      second: {
        sequence: 7,
        requestCursor: "next",
        pageIndex: 1,
        startIndex: 1,
        nextCursor: "next",
      },
      error: "cursor repeated",
    },
    {
      name: "premature terminal page",
      second: {
        sequence: 7,
        requestCursor: "next",
        pageIndex: 1,
        startIndex: 1,
        nextCursor: null,
        resultCount: 3,
      },
      error: "revision changed",
    },
  ])("rejects query $name without returning partial entries", async ({ second, error }) => {
    const key = signingKey();
    const query = { text: "CUDA" };
    enqueueSigned(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, {
      ...base,
      sequence: 7,
      query,
      requestCursor: null,
      pageIndex: 0,
      startIndex: 0,
      resultCount: 2,
      entries: [entry],
      nextCursor: "next",
    });
    enqueueSigned(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, {
      ...base,
      sequence: 7,
      query,
      requestCursor: "next",
      pageIndex: 1,
      startIndex: 1,
      resultCount: 2,
      entries: [{ ...entry, id: "skills:two", name: "two" }],
      nextCursor: null,
      ...second,
    });

    await expect(
      fetchPublisherFeedQuery({
        baseUrl: "https://clawhub.ai",
        publisherId: "publishers:alice",
        verification: verification(key),
        query,
        now: () => new Date("2026-07-16T00:01:00.000Z"),
      }),
    ).rejects.toThrow(error);
  });

  it("assembles a complete signed changed-since range", async () => {
    const key = signingKey();
    enqueueSigned(key, PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE, {
      ...base,
      fromSequence: 7,
      toSequence: 9,
      requestCursor: null,
      pageIndex: 0,
      startIndex: 0,
      changeCount: 2,
      changes: [{ sequence: 8, operation: "remove", entryId: "skills:old", entryKind: "skill" }],
      nextCursor: "next-change",
    });
    enqueueSigned(key, PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE, {
      ...base,
      fromSequence: 7,
      toSequence: 9,
      requestCursor: "next-change",
      pageIndex: 1,
      startIndex: 1,
      changeCount: 2,
      changes: [{ sequence: 9, operation: "upsert", entry }],
      nextCursor: null,
    });

    const result = await fetchPublisherFeedChanges({
      baseUrl: "https://clawhub.ai",
      publisherId: "publishers:alice",
      verification: verification(key),
      fromSequence: 7,
      limit: 1,
      now: () => new Date("2026-07-16T00:01:00.000Z"),
    });

    expect(result).toMatchObject({ status: "complete", fromSequence: 7, toSequence: 9 });
    if (result.status === "complete") {
      expect(result.changes).toHaveLength(2);
    }
  });

  it("applies a complete change range atomically without mutating current state", () => {
    const currentEntry = { ...entry, id: "skills:old", name: "old", updatedAt: 1 };
    const current = {
      feedId: base.feedId,
      sequence: 7,
      publisherId: "publishers:alice",
      handle: "alice",
      displayName: "Alice",
      entries: [currentEntry],
    };
    const applied = applyPublisherFeedChanges(current, {
      status: "complete",
      feedId: base.feedId,
      fromSequence: 7,
      toSequence: 9,
      generatedAt: base.generatedAt,
      expiresAt: base.expiresAt,
      changes: [
        { sequence: 8, operation: "remove", entryId: "skills:old", entryKind: "skill" },
        { sequence: 9, operation: "upsert", entry },
        {
          sequence: 9,
          operation: "metadata",
          metadata: {
            publisherId: "publishers:alice",
            handle: "alice-ai",
            displayName: "Alice AI",
          },
        },
      ],
    });

    expect(applied).toMatchObject({
      status: "applied",
      state: {
        sequence: 9,
        handle: "alice-ai",
        displayName: "Alice AI",
        entries: [{ id: "skills:cuda" }],
      },
    });
    expect(current).toMatchObject({ sequence: 7, handle: "alice", entries: [currentEntry] });
  });

  it("orders equal-timestamp entries by locale-independent code units", () => {
    const current = {
      feedId: base.feedId,
      sequence: 7,
      publisherId: "publishers:alice",
      handle: "alice",
      displayName: "Alice",
      entries: [],
    };
    const applied = applyPublisherFeedChanges(current, {
      status: "complete",
      feedId: base.feedId,
      fromSequence: 7,
      toSequence: 8,
      generatedAt: base.generatedAt,
      expiresAt: base.expiresAt,
      changes: [
        { sequence: 8, operation: "upsert", entry: { ...entry, id: "skills:a" } },
        { sequence: 8, operation: "upsert", entry: { ...entry, id: "skills:Z" } },
      ],
    });

    expect(applied).toMatchObject({
      status: "applied",
      state: { entries: [{ id: "skills:Z" }, { id: "skills:a" }] },
    });
  });

  it("rejects incomplete change ranges before exposing a next state", () => {
    const current = {
      feedId: base.feedId,
      sequence: 7,
      publisherId: "publishers:alice",
      handle: "alice",
      displayName: "Alice",
      entries: [],
    };
    expect(() =>
      applyPublisherFeedChanges(current, {
        status: "complete",
        feedId: base.feedId,
        fromSequence: 7,
        toSequence: Number.MAX_SAFE_INTEGER,
        generatedAt: base.generatedAt,
        expiresAt: base.expiresAt,
        changes: [{ sequence: 9, operation: "upsert", entry }],
      }),
    ).toThrow("omitted a revision");
    expect(() =>
      applyPublisherFeedChanges(current, {
        status: "complete",
        feedId: base.feedId,
        fromSequence: 7,
        toSequence: 9,
        generatedAt: base.generatedAt,
        expiresAt: base.expiresAt,
        changes: [
          {
            sequence: 7,
            operation: "remove",
            entryId: "skills:old",
            entryKind: "skill",
          },
          { sequence: 8, operation: "upsert", entry },
        ],
      }),
    ).toThrow("not ordered within the signed range");
  });

  it("rejects reset instructions that do not continue the current state", () => {
    expect(() =>
      applyPublisherFeedChanges(
        {
          feedId: base.feedId,
          sequence: 7,
          publisherId: "publishers:alice",
          handle: "alice",
          displayName: "Alice",
          entries: [],
        },
        {
          status: "reset-required",
          reset: {
            ...base,
            feedId: "clawhub.publisher.publishers:bob",
            fromSequence: 7,
            currentSequence: 9,
            resetRequired: true,
            snapshotUrl: "https://clawhub.ai/api/v1/publishers/publishers%3Abob/feed",
          },
        },
      ),
    ).toThrow("reset does not continue");
  });

  it("accepts only a first-page same-origin signed reset response", async () => {
    const key = signingKey();
    enqueueSigned(
      key,
      PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE,
      {
        ...base,
        fromSequence: 1,
        currentSequence: 9,
        resetRequired: true,
        snapshotUrl: "https://clawhub.ai/api/v1/publishers/publishers%3Aalice/feed",
      },
      409,
    );

    await expect(
      fetchPublisherFeedChanges({
        baseUrl: "https://clawhub.ai",
        publisherId: "publishers:alice",
        verification: verification(key),
        fromSequence: 1,
        now: () => new Date("2026-07-16T00:01:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "reset-required", reset: { currentSequence: 9 } });

    enqueueSigned(
      key,
      PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE,
      {
        ...base,
        fromSequence: 1,
        currentSequence: 9,
        resetRequired: true,
        snapshotUrl: "https://evil.example/api/v1/publishers/publishers%3Aalice/feed",
      },
      409,
    );
    await expect(
      fetchPublisherFeedChanges({
        baseUrl: "https://clawhub.ai",
        publisherId: "publishers:alice",
        verification: verification(key),
        fromSequence: 1,
        now: () => new Date("2026-07-16T00:01:00.000Z"),
      }),
    ).rejects.toThrow("reset instruction is invalid");

    enqueueSigned(
      key,
      PUBLISHER_FEED_CHANGES_PAYLOAD_TYPE,
      {
        ...base,
        fromSequence: 1,
        currentSequence: 9,
        resetRequired: true,
        snapshotUrl: "https://user:secret@clawhub.ai/api/v1/publishers/publishers%3Aalice/feed",
      },
      409,
    );
    await expect(
      fetchPublisherFeedChanges({
        baseUrl: "https://clawhub.ai",
        publisherId: "publishers:alice",
        verification: verification(key),
        fromSequence: 1,
        now: () => new Date("2026-07-16T00:01:00.000Z"),
      }),
    ).rejects.toThrow("reset instruction is invalid");
  });

  it("rejects redirects, wrong content types, and page-count exhaustion", async () => {
    const key = signingKey();
    const payload = {
      ...base,
      sequence: 7,
      query: { text: "CUDA" },
      requestCursor: null,
      pageIndex: 0,
      startIndex: 0,
      resultCount: 2,
      entries: [entry],
      nextCursor: "next",
    };
    enqueueSigned(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, payload);
    queuedResponses[0]!.finalUrl = "https://clawhub.ai/redirected";
    await expect(
      fetchPublisherFeedQuery({
        baseUrl: "https://clawhub.ai",
        publisherId: "publishers:alice",
        verification: verification(key),
        query: { text: "CUDA" },
      }),
    ).rejects.toThrow("redirected away");

    enqueueSigned(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, payload, 200, {
      "content-type": "application/json",
    });
    await expect(
      fetchPublisherFeedQuery({
        baseUrl: "https://clawhub.ai",
        publisherId: "publishers:alice",
        verification: verification(key),
        query: { text: "CUDA" },
      }),
    ).rejects.toThrow("unsupported content type");

    enqueueSigned(key, PUBLISHER_FEED_QUERY_PAYLOAD_TYPE, payload);
    await expect(
      fetchPublisherFeedQuery({
        baseUrl: "https://clawhub.ai",
        publisherId: "publishers:alice",
        verification: verification(key),
        query: { text: "CUDA" },
        maxPages: 1,
        now: () => new Date("2026-07-16T00:01:00.000Z"),
      }),
    ).rejects.toThrow("exceeded 1 pages");
  });
});
