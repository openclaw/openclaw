import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { DiscoveryRequestError } from "./discovery-client.js";
import { linkedClaw, nowSeconds, type LinkedClaw } from "./openclaw-id.test-support.js";
import {
  createPublicationRetry,
  PUBLICATION_REFRESH_MS,
  PUBLICATION_RETRY_INITIAL_MS,
  PUBLICATION_RETRY_MAX_MS,
  publicationPending,
} from "./publication-retry.js";
import { publishClaw, type PublishOutcome } from "./publisher.js";

const log = () => ({ info: vi.fn(), warn: vi.fn() });

// A Discovery mirror that keeps the last snapshot seq and fails the calls it is told to.
function fakeDiscovery() {
  type Call = "descriptor" | "snapshot";
  const failures: Array<{ call: Call; error: Error }> = [];
  const mirror = {
    snapshotSeq: 1,
    snapshotIssuedAt: 0,
    descriptors: 0,
    snapshots: 0,
    snapshot: undefined as SignedStatement<"MembershipSnapshot"> | undefined,
  };
  const take = (call: Call) => {
    const index = failures.findIndex((failure) => failure.call === call);
    const [failure] = index >= 0 ? failures.splice(index, 1) : [];
    if (failure) {
      throw failure.error;
    }
  };
  const client = {
    registerClaw: vi.fn(),
    publishDescriptor: vi.fn(async () => {
      take("descriptor");
      mirror.descriptors += 1;
    }),
    publishSnapshot: vi.fn(
      async (_clawId: string, snapshot: SignedStatement<"MembershipSnapshot">) => {
        take("snapshot");
        mirror.snapshotSeq = snapshot.body.seq;
        mirror.snapshotIssuedAt = snapshot.body.issued_at;
        mirror.snapshots += 1;
        mirror.snapshot = snapshot;
      },
    ),
  };
  return {
    client,
    mirror,
    fail: (call: Call, error: Error) => failures.push({ call, error }),
  };
}

// A linked, registered claw whose seq-1 state Discovery already has, wired to a retrier.
async function registeredClaw() {
  const claw = await linkedClaw();
  await claw.authority.recordDiscovery({
    owner_account_id: "acct-owner",
    published_binding_seq: 1,
    published_snapshot_seq: 1,
  });
  const discovery = fakeDiscovery();
  const signer = await generateEd25519Signer();
  const outcomes: PublishOutcome[] = [];
  // The attempt in flight; timer-fired retries are awaited through it (signing is real crypto).
  let inflight: Promise<unknown> = Promise.resolve();
  const attempt = async () => {
    const record = claw.authority.current()!;
    const outcome = await publishClaw({
      record,
      relayUrl: "https://relay.example.test/",
      client: discovery.client as never,
      signer,
    });
    outcomes.push(outcome);
    if (outcome.state === "published") {
      await claw.authority.recordDiscovery({
        published_binding_seq: record.binding!.body.binding_seq,
        published_snapshot_seq: outcome.snapshotSeq,
        published_snapshot_at: outcome.snapshotIssuedAt,
      });
    }
    return outcome;
  };
  const publish = () => {
    const run = attempt();
    inflight = run;
    return run;
  };
  // Fires due retry timers and waits until the attempts they start have settled.
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await inflight;
    await vi.advanceTimersByTimeAsync(0);
  };
  const logger = log();
  const retry = createPublicationRetry({
    publish,
    current: () => claw.authority.current(),
    setPending: (pending) => claw.authority.recordDiscovery({ publish_pending: pending }),
    log: logger,
    random: () => 1,
  });
  return { claw, discovery, retry, outcomes, logger, advance };
}

// What a browser with the recovery kit mails: R signs add_owner_device at the mirror's seq + 1.
async function kitEnrollment(claw: LinkedClaw, mirrorSeq: number) {
  const device = await generateEd25519Signer();
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [formatIrohEndpointKey(randomBytes(32))],
      label: "laptop",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: nowSeconds(),
      expires_at: null,
      root_epoch: 1,
    },
    claw.root,
  );
  return await signStatement(
    "MembershipChange",
    {
      claw_id: claw.clawId,
      seq: mirrorSeq + 1,
      target: { op: "add_owner_device", cert },
      issued_at: nowSeconds(),
    },
    claw.root,
  );
}

describe("publication retry (OCF-313)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers from one failed publish with no manual step, so the next kit enrollment succeeds", async () => {
    const { claw, discovery, retry, advance } = await registeredClaw();
    await retry.start();
    // A membership change (kit enrollment #1) is accepted at seq 2 ...
    const first = await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    expect(first.ok).toBe(true);
    // ... and its publication hits a Discovery outage.
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await retry.request();
    expect(discovery.mirror.snapshotSeq).toBe(1);
    expect(publicationPending(claw.authority.current())).toBe(true);
    expect(claw.authority.current()?.discovery.publish_pending).toBe(true);
    expect(retry.nextRetryAt()).toBeDefined();

    // Discovery is back; the scheduled retry catches the mirror up on its own.
    await advance(PUBLICATION_RETRY_INITIAL_MS);
    expect(discovery.mirror.snapshotSeq).toBe(2);
    expect(publicationPending(claw.authority.current())).toBe(false);
    expect(retry.nextRetryAt()).toBeUndefined();

    // A second browser signs at the mirror's seq + 1 and is accepted.
    const second = await claw.authority.submit(
      await kitEnrollment(claw, discovery.mirror.snapshotSeq),
      "mailbox",
    );
    expect(second.ok).toBe(true);
  });

  it("without the retry, the same outage leaves the next kit enrollment refused as seq_conflict", async () => {
    const { claw, discovery, retry, advance } = await registeredClaw();
    // Retries disabled (not started): one attempt only, as before OCF-313.
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await retry.request();
    await advance(PUBLICATION_RETRY_MAX_MS);
    expect(discovery.mirror.snapshotSeq).toBe(1);
    const refused = await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    expect(refused).toMatchObject({ ok: false, code: "seq_conflict" });
  });

  it("backs off exponentially up to the cap and keeps retrying until Discovery answers", async () => {
    const { claw, discovery, retry, outcomes, advance } = await registeredClaw();
    await retry.start();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    for (let i = 0; i < 12; i++) {
      discovery.fail(
        "snapshot",
        new DiscoveryRequestError(503, "unavailable", "temporary failure"),
      );
    }
    const delays: number[] = [];
    await retry.request();
    for (let i = 0; i < 20 && outcomes.at(-1)?.state !== "published"; i++) {
      const at = retry.nextRetryAt();
      expect(at).toBeDefined();
      delays.push(at! - Date.now());
      await advance(at! - Date.now());
    }
    expect(delays.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...delays)).toBe(PUBLICATION_RETRY_MAX_MS);
    // The re-sign at start, then 12 failures and the success.
    expect(outcomes).toHaveLength(14);
    expect(discovery.mirror.snapshotSeq).toBe(2);
  });

  it("does not retry a refusal that will not change (4xx), but keeps it pending for the next start", async () => {
    const { claw, discovery, retry, logger } = await registeredClaw();
    await retry.start();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    discovery.fail("snapshot", new DiscoveryRequestError(400, "bad_request", "invalid snapshot"));
    await retry.request();
    expect(retry.nextRetryAt()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("refused (bad_request)"));
    expect(publicationPending(claw.authority.current())).toBe(true);
    retry.stop();
    await retry.start();
    expect(discovery.mirror.snapshotSeq).toBe(2);
    expect(publicationPending(claw.authority.current())).toBe(false);
  });

  it("resumes a pending publication at startup (after a restart) and on reconnect, with the backoff reset", async () => {
    const { claw, discovery, retry } = await registeredClaw();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    // Durable: the record says seq 2 was never published.
    expect(publicationPending(claw.authority.current())).toBe(true);
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await retry.start();
    expect(retry.nextRetryAt()).toBeDefined();
    // The mailbox reconnects before the timer fires: publish now.
    await retry.resume();
    expect(discovery.mirror.snapshotSeq).toBe(2);
    expect(retry.nextRetryAt()).toBeUndefined();
  });

  it("stops scheduling retries on stop; the pending flag survives", async () => {
    const { claw, discovery, retry, outcomes, advance } = await registeredClaw();
    await retry.start();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await retry.request();
    retry.stop();
    await advance(PUBLICATION_RETRY_MAX_MS * 2);
    // The re-sign at start and the failed attempt; nothing after stop.
    expect(outcomes).toHaveLength(2);
    expect(claw.authority.current()?.discovery.publish_pending).toBe(true);
  });

  it("adopts a failed direct publication (linking) and retries it with backoff", async () => {
    const { claw, discovery, retry, advance, outcomes } = await registeredClaw();
    await retry.start();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    discovery.fail("snapshot", new TypeError("fetch failed"));
    // The caller published itself to report the outcome, as commitLink does.
    const record = claw.authority.current()!;
    const direct = await publishClaw({
      record,
      relayUrl: "https://relay.example.test/",
      client: discovery.client as never,
      signer: await generateEd25519Signer(),
    });
    expect(direct).toMatchObject({ state: "failed", retryable: true });
    await retry.adopt(direct);
    expect(claw.authority.current()?.discovery.publish_pending).toBe(true);
    expect(retry.nextRetryAt()).toBeDefined();
    await advance(PUBLICATION_RETRY_INITIAL_MS);
    expect(outcomes.at(-1)?.state).toBe("published");
    expect(discovery.mirror.snapshotSeq).toBe(2);
    expect(publicationPending(claw.authority.current())).toBe(false);
  });

  it("coalesces requests that arrive during an attempt into one follow-up", async () => {
    let release: (() => void) | undefined;
    const publish = vi.fn(
      () =>
        new Promise<PublishOutcome>((resolve) => {
          release = () =>
            resolve({
              state: "published",
              ownerAccountId: "a",
              snapshotSeq: 1,
              snapshotIssuedAt: nowSeconds(),
            });
        }),
    );
    const setPending = vi.fn(async () => {});
    const retry = createPublicationRetry({
      publish,
      current: () => undefined,
      setPending,
      log: log(),
    });
    const first = retry.request();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await Promise.all([retry.request(), retry.request()]);
    release!();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    release!();
    await first;
    expect(publish).toHaveBeenCalledTimes(2);
    expect(setPending).toHaveBeenLastCalledWith(false);
  });

  it("republishes a request that arrives while a successful attempt clears pending", async () => {
    let seq = 1;
    const published: number[] = [];
    // Each durable pending write, with the newest seq published when it landed.
    const writes: Array<[pending: boolean, publishedSeq: number | undefined]> = [];
    const clearReached = Promise.withResolvers<void>();
    const clearReleased = Promise.withResolvers<void>();
    const retry = createPublicationRetry({
      publish: async () => {
        published.push(seq);
        return {
          state: "published",
          ownerAccountId: "a",
          snapshotSeq: seq,
          snapshotIssuedAt: nowSeconds(),
        };
      },
      current: () => undefined,
      setPending: async (pending) => {
        // Hold the clear after the first publication until the newer request is in.
        if (!pending && published.length === 1) {
          clearReached.resolve();
          await clearReleased.promise;
        }
        writes.push([pending, published.at(-1)]);
      },
      log: log(),
    });
    const first = retry.request();
    await clearReached.promise;
    seq = 2;
    await retry.request();
    clearReleased.resolve();
    await first;
    expect(published).toEqual([1, 2]);
    expect(writes).toEqual([
      [true, undefined],
      [true, 1],
      // The held clear lands after the newer request's write, so pending is marked again.
      [false, 1],
      [true, 1],
      [false, 2],
    ]);
  });
});

// An owner-signed Revocation of the claw's linked owner device D1, signed by R.
async function revocationOfD1(claw: LinkedClaw) {
  const { fingerprint } = await import("../../../packages/openclaw-id-protocol/src/index.js");
  return await signStatement(
    "Revocation",
    {
      claw_id: claw.clawId,
      seq: 1,
      target_fp: await fingerprint(formatEd25519PublicKey(claw.device.publicKey)),
      target_kind: "owner_device",
      reason: "lost",
      root_epoch: 1,
      issued_at: nowSeconds(),
    },
    claw.root,
  );
}

describe("snapshot freshness (freshness/v1, OCF-320)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-signs the same seq at startup even when Discovery is current", async () => {
    const { discovery, retry, advance } = await registeredClaw();
    await vi.advanceTimersByTimeAsync(10_000);
    await retry.start();
    await advance(0);
    expect(discovery.mirror.snapshots).toBe(1);
    expect(discovery.mirror.snapshotSeq).toBe(1);
    expect(retry.nextRefreshAt()).toBeDefined();
  });

  it("keeps an idle claw's published snapshot younger than an hour for two hours", async () => {
    const { discovery, retry, advance } = await registeredClaw();
    await retry.start();
    await advance(0);
    for (let minute = 5; minute <= 120; minute += 5) {
      await advance(5 * 60_000);
      const age = nowSeconds() - discovery.mirror.snapshotIssuedAt;
      expect(age, `minute ${minute}`).toBeLessThan(3600);
    }
    expect(discovery.mirror.snapshotSeq).toBe(1);
    expect(discovery.mirror.snapshots).toBeGreaterThanOrEqual(3);
  });

  it("re-signs no later than PUBLICATION_REFRESH_MS after a change, then keeps the rhythm", async () => {
    const { claw, discovery, retry, advance } = await registeredClaw();
    await retry.start();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    await retry.request();
    const after = discovery.mirror.snapshots;
    await advance(PUBLICATION_REFRESH_MS);
    expect(discovery.mirror.snapshots).toBe(after + 1);
    expect(discovery.mirror.snapshotSeq).toBe(2);
  });

  it("retries a failed re-sign with backoff and returns to the hourly rhythm", async () => {
    const { discovery, retry, advance } = await registeredClaw();
    await retry.start();
    await advance(0);
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await advance(PUBLICATION_REFRESH_MS);
    expect(retry.nextRetryAt()).toBeDefined();
    await advance(PUBLICATION_RETRY_INITIAL_MS);
    expect(nowSeconds() - discovery.mirror.snapshotIssuedAt).toBeLessThan(5);
    expect(retry.nextRefreshAt()).toBeDefined();
  });

  it("stops re-signing on stop", async () => {
    const { discovery, retry, advance } = await registeredClaw();
    await retry.start();
    await advance(0);
    retry.stop();
    const count = discovery.mirror.snapshots;
    await advance(3 * PUBLICATION_REFRESH_MS);
    expect(discovery.mirror.snapshots).toBe(count);
    expect(retry.nextRefreshAt()).toBeUndefined();
  });

  it("does not retry stale_snapshot: Discovery already holds one at least as new", async () => {
    const { discovery, retry, advance, logger } = await registeredClaw();
    discovery.fail("snapshot", new DiscoveryRequestError(409, "stale_snapshot", "older"));
    await retry.start();
    await advance(0);
    expect(retry.nextRetryAt()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("stale_snapshot"));
  });
});

describe("removal publication (allowlist)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes a snapshot without the removed device and without any revoked list", async () => {
    const { claw, discovery, retry, advance } = await registeredClaw();
    await retry.start();
    await advance(0);
    expect(discovery.mirror.snapshot?.body.owner_devices).toEqual([
      { device_pub: formatEd25519PublicKey(claw.device.publicKey), caps: expect.any(Array) },
    ]);
    expect((await claw.authority.submit(await revocationOfD1(claw), "mailbox")).ok).toBe(true);
    expect(claw.authority.current()).not.toHaveProperty("revocations");
    await retry.request();
    expect(discovery.mirror.snapshot?.body).not.toHaveProperty("revoked");
    expect(discovery.mirror.snapshot?.body.owner_devices).toEqual([]);
    expect(discovery.mirror.snapshot?.body.owner_peer_keys).toEqual([]);
    expect(publicationPending(claw.authority.current())).toBe(false);
  });
});

describe("publicationPending", () => {
  it("is false before the claw is registered with Discovery", async () => {
    const claw = await linkedClaw();
    expect(publicationPending(claw.authority.current())).toBe(false);
  });

  it("tracks the durable flag and the published seqs", async () => {
    const claw = await linkedClaw();
    await claw.authority.recordDiscovery({
      owner_account_id: "acct",
      published_binding_seq: 1,
      published_snapshot_seq: 1,
    });
    expect(publicationPending(claw.authority.current())).toBe(false);
    await claw.authority.recordDiscovery({ publish_pending: true });
    expect(publicationPending(claw.authority.current())).toBe(true);
    await claw.authority.recordDiscovery({ publish_pending: false, published_binding_seq: 0 });
    expect(publicationPending(claw.authority.current())).toBe(true);
  });
});
