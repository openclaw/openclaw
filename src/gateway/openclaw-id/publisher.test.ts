import { describe, expect, it, vi } from "vitest";
import { generateEd25519Signer } from "../../../packages/openclaw-id-protocol/src/index.js";
import { DiscoveryRequestError } from "./discovery-client.js";
import { linkedClaw } from "./openclaw-id.test-support.js";
import { isRetryableDiscoveryError, publishClaw } from "./publisher.js";

async function setup(publishedBindingSeq: number) {
  const claw = await linkedClaw();
  await claw.authority.recordDiscovery({
    owner_account_id: "acct-owner",
    published_binding_seq: publishedBindingSeq,
    published_snapshot_seq: 1,
  });
  const client = {
    registerClaw: vi.fn(),
    publishDescriptor: vi.fn(async (): Promise<void> => {
      throw new DiscoveryRequestError(503, "unavailable", "temporary failure");
    }),
    publishSnapshot: vi.fn(async (): Promise<void> => {}),
  };
  const publish = async () =>
    await publishClaw({
      record: claw.authority.current()!,
      relayUrl: "https://relay.example.test/",
      client: client as never,
      signer: await generateEd25519Signer(),
    });
  return { client, publish };
}

describe("publishClaw", () => {
  it("still publishes the snapshot when the descriptor republish fails and Discovery has the binding", async () => {
    const { client, publish } = await setup(1);
    const outcome = await publish();
    expect(client.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ state: "failed", code: "unavailable", retryable: true });
  });

  it("holds the snapshot back while Discovery lacks the binding it is signed for", async () => {
    const { client, publish } = await setup(0);
    const outcome = await publish();
    expect(client.publishSnapshot).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ state: "failed", retryable: true });
  });

  it("reports a snapshot failure as retryable when it is transient", async () => {
    const { client, publish } = await setup(1);
    client.publishDescriptor.mockResolvedValueOnce(undefined);
    client.publishSnapshot.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await publish()).toMatchObject({ state: "failed", retryable: true });
  });
});

describe("publishClaw first registration", () => {
  it("reports the registered account when the snapshot fails after registration", async () => {
    const claw = await linkedClaw();
    const client = {
      registerClaw: vi.fn(async () => ({ owner_account_id: "acct-new" })),
      publishDescriptor: vi.fn(),
      publishSnapshot: vi.fn(async (): Promise<void> => {
        throw new TypeError("fetch failed");
      }),
    };
    const outcome = await publishClaw({
      record: claw.authority.current()!,
      relayUrl: "https://relay.example.test/",
      client: client as never,
      signer: await generateEd25519Signer(),
      enrollmentCode: "one-time-code",
    });
    expect(outcome).toMatchObject({ state: "failed", retryable: true, ownerAccountId: "acct-new" });
  });

  it("does not report an account when registration itself failed", async () => {
    const claw = await linkedClaw();
    const client = {
      registerClaw: vi.fn(async () => {
        throw new DiscoveryRequestError(503, "unavailable", "x");
      }),
      publishDescriptor: vi.fn(),
      publishSnapshot: vi.fn(),
    };
    const outcome = await publishClaw({
      record: claw.authority.current()!,
      relayUrl: "https://relay.example.test/",
      client: client as never,
      signer: await generateEd25519Signer(),
      enrollmentCode: "one-time-code",
    });
    expect(outcome).toMatchObject({ state: "failed", retryable: true });
    expect(outcome).not.toHaveProperty("ownerAccountId");
    expect(client.publishSnapshot).not.toHaveBeenCalled();
  });
});

describe("isRetryableDiscoveryError", () => {
  it.each([
    [new TypeError("fetch failed"), true],
    [new DiscoveryRequestError(500, "unavailable", "x"), true],
    [new DiscoveryRequestError(503, "unavailable", "x"), true],
    [new DiscoveryRequestError(409, "conflict", "concurrent update; retry"), true],
    [new DiscoveryRequestError(429, "rate_limited", "x"), true],
    [new DiscoveryRequestError(400, "bad_request", "x"), false],
    [new DiscoveryRequestError(403, "forbidden", "x"), false],
    [new DiscoveryRequestError(404, "not_found", "x"), false],
  ])("%s -> %s", (error, expected) => {
    expect(isRetryableDiscoveryError(error)).toBe(expected);
  });
});
