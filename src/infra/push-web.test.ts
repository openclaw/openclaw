// Tests web push subscription storage and delivery helpers.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webPush, { type SendResult } from "web-push";
import {
  broadcastWebPush,
  clearWebPushSubscriptionByEndpoint,
  listWebPushSubscriptions,
  registerWebPushSubscription,
  resolveVapidKeys,
} from "./push-web.js";

function sendResult(statusCode = 201): SendResult {
  return { statusCode, body: "", headers: {} };
}

const writeJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./json-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./json-files.js")>();
  writeJsonMock.mockImplementation(actual.writeJson);
  return { ...actual, writeJson: writeJsonMock };
});

// Stub resolveStateDir so tests use a temp directory.
let tmpDir: string;
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => tmpDir,
}));

// Stub web-push so we don't make real HTTP requests.
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({
      publicKey: "test-public-key-base64url",
      privateKey: "test-private-key-base64url",
    })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} }),
  },
}));

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-web-test-"));
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_VAPID_PUBLIC_KEY", undefined);
  vi.stubEnv("OPENCLAW_VAPID_PRIVATE_KEY", undefined);
  vi.stubEnv("OPENCLAW_VAPID_SUBJECT", undefined);
  vi.mocked(webPush.sendNotification).mockReset().mockResolvedValue(sendResult());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveVapidKeys", () => {
  it("generates and persists VAPID keys on first call", async () => {
    const keys = await resolveVapidKeys(tmpDir);
    expect(keys.publicKey).toBe("test-public-key-base64url");
    expect(keys.privateKey).toBe("test-private-key-base64url");
    expect(keys.subject).toBe("https://openclaw.ai");
    const persistedKeys = JSON.parse(
      await fs.readFile(path.join(tmpDir, "push", "vapid-keys.json"), "utf8"),
    ) as { subject?: string };
    expect(persistedKeys.subject).toBe("https://openclaw.ai");

    // Second call returns same keys.
    const keys2 = await resolveVapidKeys(tmpDir);
    expect(keys2.publicKey).toBe(keys.publicKey);
    expect(keys2.privateKey).toBe(keys.privateKey);
    expect(vi.mocked(webPush.generateVAPIDKeys)).toHaveBeenCalledTimes(1);
  });

  it("prefers env vars over persisted keys", async () => {
    // Persist keys first.
    await resolveVapidKeys(tmpDir);

    // Set env overrides.
    vi.stubEnv("OPENCLAW_VAPID_PUBLIC_KEY", "env-public");
    vi.stubEnv("OPENCLAW_VAPID_PRIVATE_KEY", "env-private");
    vi.stubEnv("OPENCLAW_VAPID_SUBJECT", "mailto:env@test.com");

    const keys = await resolveVapidKeys(tmpDir);
    expect(keys.publicKey).toBe("env-public");
    expect(keys.privateKey).toBe("env-private");
    expect(keys.subject).toBe("mailto:env@test.com");
    expect(vi.mocked(webPush.generateVAPIDKeys)).toHaveBeenCalledTimes(1);
  });
});

describe("subscription CRUD", () => {
  const endpoint = "https://push.example.com/send/abc123";
  const keys = { p256dh: "p256dh-key", auth: "auth-key" };

  it("registers a new subscription", async () => {
    const sub = await registerWebPushSubscription({
      endpoint,
      keys,
      baseDir: tmpDir,
    });
    expect(sub.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sub.endpoint).toBe(endpoint);
    expect(sub.keys.p256dh).toBe("p256dh-key");
    expect(sub.keys.auth).toBe("auth-key");
    expect(sub.createdAtMs).toBeGreaterThan(0);
  });

  it("updates an existing subscription with the same endpoint", async () => {
    const sub1 = await registerWebPushSubscription({
      endpoint,
      keys,
      baseDir: tmpDir,
    });
    const sub2 = await registerWebPushSubscription({
      endpoint,
      keys: { p256dh: "new-p256dh", auth: "new-auth" },
      baseDir: tmpDir,
    });
    // Same subscription ID, same created time, updated keys.
    expect(sub2.subscriptionId).toBe(sub1.subscriptionId);
    expect(sub2.createdAtMs).toBe(sub1.createdAtMs);
    expect(sub2.keys.p256dh).toBe("new-p256dh");
  });

  it("lists all subscriptions", async () => {
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/a",
      keys,
      baseDir: tmpDir,
    });
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/b",
      keys,
      baseDir: tmpDir,
    });
    const list = await listWebPushSubscriptions(tmpDir);
    expect(list).toHaveLength(2);
  });

  it("clears a subscription by endpoint", async () => {
    await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    const removed = await clearWebPushSubscriptionByEndpoint(endpoint, tmpDir);
    expect(removed).toBe(true);

    const list = await listWebPushSubscriptions(tmpDir);
    expect(list).toHaveLength(0);
  });

  it("rejects invalid endpoint", async () => {
    await expect(
      registerWebPushSubscription({
        endpoint: "http://insecure.example.com",
        keys,
        baseDir: tmpDir,
      }),
    ).rejects.toThrow("invalid push subscription endpoint");
  });

  it("rejects empty keys", async () => {
    await expect(
      registerWebPushSubscription({
        endpoint,
        keys: { p256dh: "", auth: "auth-key" },
        baseDir: tmpDir,
      }),
    ).rejects.toThrow("invalid push subscription keys");
  });
});

describe("sending", () => {
  const keys = { p256dh: "p256dh-key", auth: "auth-key" };

  it("passes resolved VAPID details to each subscriber send", async () => {
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/a",
      keys,
      baseDir: tmpDir,
    });
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/b",
      keys,
      baseDir: tmpDir,
    });

    const results = await broadcastWebPush({ title: "Broadcast" }, tmpDir);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(vi.mocked(webPush.setVapidDetails)).not.toHaveBeenCalled();
    expect(vi.mocked(webPush.sendNotification)).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(webPush.sendNotification).mock.calls) {
      expect(call[2]).toEqual({
        vapidDetails: {
          subject: "https://openclaw.ai",
          publicKey: "test-public-key-base64url",
          privateKey: "test-private-key-base64url",
        },
      });
    }
  });

  it("keeps VAPID identities isolated across overlapping bounded broadcasts", async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-web-overlap-test-"));
    try {
      const writeVapidKeys = async (baseDir: string, publicKey: string, privateKey: string) => {
        const pushDir = path.join(baseDir, "push");
        await fs.mkdir(pushDir, { recursive: true });
        await fs.writeFile(
          path.join(pushDir, "vapid-keys.json"),
          JSON.stringify({ publicKey, privateKey, subject: "https://openclaw.ai" }),
        );
      };
      await writeVapidKeys(tmpDir, "public-a", "private-a");
      await writeVapidKeys(otherDir, "public-b", "private-b");
      for (let index = 0; index < 13; index += 1) {
        await registerWebPushSubscription({
          endpoint: `https://push-a.example.com/${index}`,
          keys,
          baseDir: tmpDir,
        });
        await registerWebPushSubscription({
          endpoint: `https://push-b.example.com/${index}`,
          keys,
          baseDir: otherDir,
        });
      }

      let releaseSends!: () => void;
      const sendsReleased = new Promise<void>((resolve) => {
        releaseSends = resolve;
      });
      let resolveFirstBroadcastStarted!: () => void;
      const firstBroadcastStarted = new Promise<void>((resolve) => {
        resolveFirstBroadcastStarted = resolve;
      });
      let resolveSecondBroadcastStarted!: () => void;
      const secondBroadcastStarted = new Promise<void>((resolve) => {
        resolveSecondBroadcastStarted = resolve;
      });
      let firstStarted = 0;
      let secondStarted = 0;

      vi.mocked(webPush.sendNotification).mockImplementation(async (subscription) => {
        if (subscription.endpoint.includes("push-a")) {
          firstStarted += 1;
          if (firstStarted === 12) {
            resolveFirstBroadcastStarted();
          }
        } else {
          secondStarted += 1;
          if (secondStarted === 12) {
            resolveSecondBroadcastStarted();
          }
        }
        await sendsReleased;
        return sendResult();
      });

      const firstBroadcast = broadcastWebPush({ title: "First" }, tmpDir);
      await firstBroadcastStarted;
      const secondBroadcast = broadcastWebPush({ title: "Second" }, otherDir);
      await secondBroadcastStarted;
      releaseSends();
      await Promise.all([firstBroadcast, secondBroadcast]);

      for (const [subscription, , options] of vi.mocked(webPush.sendNotification).mock.calls) {
        const isFirst = subscription.endpoint.includes("push-a");
        expect(options).toMatchObject({
          vapidDetails: {
            publicKey: isFirst ? "public-a" : "public-b",
            privateKey: isFirst ? "private-a" : "private-b",
          },
        });
      }
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it("bounds concurrent sends while preserving the full broadcast", async () => {
    const subscriptionCount = 13;
    const concurrencyLimit = 12;
    await Promise.all(
      Array.from({ length: subscriptionCount }, (_, index) =>
        registerWebPushSubscription({
          endpoint: `https://push.example.com/${index}`,
          keys,
          baseDir: tmpDir,
        }),
      ),
    );

    let releaseSends!: () => void;
    const sendsReleased = new Promise<void>((resolve) => {
      releaseSends = resolve;
    });
    let resolveFirstBatchStarted!: () => void;
    const firstBatchStarted = new Promise<void>((resolve) => {
      resolveFirstBatchStarted = resolve;
    });
    let started = 0;
    let inFlight = 0;
    let peakInFlight = 0;

    vi.mocked(webPush.sendNotification).mockImplementation(async () => {
      started += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (started === concurrencyLimit) {
        resolveFirstBatchStarted();
      }
      await sendsReleased;
      inFlight -= 1;
      return sendResult();
    });

    const broadcast = broadcastWebPush({ title: "Bounded broadcast" }, tmpDir);
    await firstBatchStarted;

    expect(started).toBe(concurrencyLimit);
    expect(peakInFlight).toBe(concurrencyLimit);

    releaseSends();
    const results = await broadcast;

    expect(results).toHaveLength(subscriptionCount);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(webPush.sendNotification).toHaveBeenCalledTimes(subscriptionCount);
  });

  it("does not clear a subscription refreshed while an expired send is in flight", async () => {
    const endpoint = "https://push.example.com/refreshed";
    await registerWebPushSubscription({ endpoint, keys, baseDir: tmpDir });
    let resolveSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      resolveSendStarted = resolve;
    });
    let releaseSend!: () => void;
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    vi.mocked(webPush.sendNotification).mockImplementationOnce(async () => {
      resolveSendStarted();
      await sendReleased;
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });

    const broadcast = broadcastWebPush({ title: "Refresh overlap" }, tmpDir);
    await sendStarted;
    await registerWebPushSubscription({
      endpoint,
      keys: { p256dh: "refreshed-p256dh", auth: "refreshed-auth" },
      baseDir: tmpDir,
    });
    releaseSend();
    await broadcast;

    const remaining = await listWebPushSubscriptions(tmpDir);
    expect(remaining).toMatchObject([
      { endpoint, keys: { p256dh: "refreshed-p256dh", auth: "refreshed-auth" } },
    ]);
  });

  it("keeps delivery results when expired-subscription cleanup fails", async () => {
    await registerWebPushSubscription({
      endpoint: "https://push.example.com/expired",
      keys,
      baseDir: tmpDir,
    });
    vi.stubEnv("OPENCLAW_VAPID_PUBLIC_KEY", "env-public");
    vi.stubEnv("OPENCLAW_VAPID_PRIVATE_KEY", "env-private");
    vi.mocked(webPush.sendNotification).mockRejectedValueOnce(
      Object.assign(new Error("gone"), { statusCode: 410 }),
    );
    writeJsonMock.mockRejectedValueOnce(new Error("cleanup write failed"));

    const results = await broadcastWebPush({ title: "Cleanup failure" }, tmpDir);
    const remaining = await listWebPushSubscriptions(tmpDir);

    expect(results).toMatchObject([{ ok: false, statusCode: 410, error: "gone" }]);
    expect(remaining).toHaveLength(1);
  });

  it("removes expired subscriptions after a mixed-result broadcast", async () => {
    for (const endpoint of ["live", "gone", "missing"]) {
      await registerWebPushSubscription({
        endpoint: `https://push.example.com/${endpoint}`,
        keys,
        baseDir: tmpDir,
      });
    }
    vi.mocked(webPush.sendNotification)
      .mockResolvedValueOnce(sendResult())
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { statusCode: 404 }));

    const results = await broadcastWebPush({ title: "Cleanup" }, tmpDir);
    const remaining = await listWebPushSubscriptions(tmpDir);

    expect(results.map((result) => result.statusCode)).toEqual([201, 410, 404]);
    expect(remaining.map((subscription) => subscription.endpoint)).toEqual([
      "https://push.example.com/live",
    ]);
  });
});
