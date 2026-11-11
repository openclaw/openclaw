import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  generateEphemeralKey,
  hexToBytes,
  openHandoff,
  ownerDeviceCertBody,
  sasCode,
  sasCommitment,
  sasSharedSecret,
  sasTranscript,
  signStatement,
  verifyOwnerStatement,
  type MailboxMessage,
  type SignedStatement,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createOwnerApproval, type OwnerApproval } from "./owner-approval.ts";

const held = vi.hoisted(() => ({ d: undefined as unknown, w: undefined as unknown }));
// mock-isolation: the signed-in account and device key come from fixtures instead of browser storage.
vi.mock("./device-key.ts", () => ({
  loadOwnerDeviceSigner: async () => held.d,
  loadMailboxPeerSigner: async () => held.w,
}));
// mock-isolation: the signed-in account and device key come from fixtures instead of browser storage.
vi.mock("./account.ts", () => ({
  openClawIdAccount: () => ({ sub: "owner", idToken: "test-account-token" }),
}));
let owner: OwnerApproval;
beforeEach(() => {
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => callback({}),
    },
  });
});
afterEach(() => {
  owner?.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Emulates only remote mailbox I/O: the browser approver and both sides' cryptography are real.
async function setup(refuse = false, invalid?: "sender" | "expired" | "commitment") {
  const root = await generateEd25519Signer();
  const d = await generateEd25519Signer();
  held.d = d;
  held.w = await generateEd25519Signer();
  const n = await generateEd25519Signer();
  const ephN = await generateEphemeralKey();
  const rootPub = formatEd25519PublicKey(root.publicKey);
  const clawId = "12".repeat(16);
  const ts = Math.floor(Date.now() / 1000);
  const cert = await signStatement(
    "OwnerDeviceCert",
    ownerDeviceCertBody({
      device_pub: formatEd25519PublicKey(d.publicKey),
      label: "local",
      now: ts,
    }),
    root,
  );
  const binding = await signStatement(
    "ServerBinding",
    {
      claw_id: clawId,
      hostname: "lab.claws.test",
      k_srv: formatIrohEndpointKey(n.publicKey),
      k_gw: formatEd25519PublicKey(n.publicKey),
      binding_seq: 1,
      root_epoch: 1,
      issued_at: ts,
    },
    root,
  );
  const start = {
    request_id: "34".repeat(16),
    claw_id: clawId,
    device_pub: formatEd25519PublicKey(n.publicKey),
    peer_key: formatIrohEndpointKey(n.publicKey),
    label: "New browser",
  };
  const commit = await sasCommitment(ephN.publicKey, start);
  const sender = await fingerprint(start.device_pub);
  const message = (step: "start" | "key", data: Record<string, unknown>): MailboxMessage => ({
    message_id: "56".repeat(16),
    claw_id: clawId,
    to: "owners",
    from: {
      device_fp: sender,
      account_id: "owner",
      email: null,
      display_name: null,
      reported_by: "openclaw-id",
    },
    location_hint: null,
    received_at: ts,
    expires_at: ts + 300,
    payload: { kind: "enrollment", request_id: start.request_id, step, data },
  });
  const first = message("start", {
    ...start,
    commit: invalid === "commitment" ? "00".repeat(32) : commit,
  });
  if (invalid === "sender") {
    first.from.device_fp = `fp:${"00".repeat(32)}`;
  }
  if (invalid === "expired") {
    first.received_at = ts - 301;
  }
  const queue: MailboxMessage[] = [first];
  let reads = 0;
  let shared: Uint8Array;
  let transcript: Uint8Array;
  let matching: string | undefined;
  const operations: string[] = [];
  let submitted: SignedStatement<"MembershipChange"> | undefined;
  let handoff: unknown;
  const mockClient = {
    request: vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.action === "submit") {
        operations.push("submit");
        if (refuse) {
          throw new Error("seq conflict");
        }
        submitted = params.statement as SignedStatement<"MembershipChange">;
        // The claw lists the approving device D; it is the only owner it accepts.
        const owners = (key: string) => (key === cert.body.device_pub ? cert.body.caps : undefined);
        expect(
          (await verifyOwnerStatement(submitted, { root_pub: rootPub }, { now: ts, owners })).ok,
        ).toBe(true);
        return { status: "applied" };
      }
      if (params.operation === "context") {
        return {
          binding,
          link: {
            linked: true,
            clawId,
            rootPub,
            seq: 1,
            ownerDevices: [
              {
                devicePub: cert.body.device_pub,
                deviceFp: "fp:local",
                label: "local",
                peerKeys: [],
                approvedBy: "root",
                lastSeen: ts,
                cert,
              },
            ],
          },
        };
      }
      if (params.operation === "receive") {
        reads += 1;
        if (!queue.length) {
          return new Promise(() => {});
        }
        return { status: 200, body: JSON.stringify({ messages: queue.splice(0), cursor: "1" }) };
      }
      if (params.operation === "send") {
        const { payload } = JSON.parse(params.body as string);
        operations.push(payload.step);
        if (payload.step === "accept") {
          const ephE = hexToBytes(payload.data.eph_pub);
          shared = await sasSharedSecret(ephN, ephE);
          transcript = await sasTranscript({
            start,
            commit,
            ephemeralPublicE: ephE,
            ephemeralPublicN: ephN.publicKey,
            devicePubE: payload.data.device_pub,
          });
          matching = await sasCode(shared, transcript);
          queue.push(message("key", { eph_pub: bytesToHex(ephN.publicKey) }));
        }
        if (payload.step === "sealed") {
          handoff = await openHandoff(shared!, transcript!, payload.data);
        }
      }
      return { status: 200, body: "{}" };
    }),
  };
  const client = mockClient as unknown as GatewayBrowserClient;
  owner = createOwnerApproval(client, vi.fn());
  owner.start();
  if (invalid) {
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(invalid === "commitment" ? 3 : 2));
  } else {
    await vi.waitFor(() => expect(owner.read().requests[0]?.code).toBeTruthy());
    expect(owner.read().requests[0]?.code).toBe(matching);
  }
  return {
    client,
    request: mockClient.request,
    operations,
    read: () => ({ submitted, handoff }),
    id: start.request_id,
  };
}

describe("local original-D SAS approval", () => {
  it("does not answer with a second ephemeral key when another tab owns the lock", async () => {
    const f = await setup();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          callback: (lock: null) => Promise<void>,
        ) => callback(null),
      },
    });
    const second = createOwnerApproval(f.client, vi.fn());
    second.start();
    await vi.waitFor(() => expect(second.read().error).toContain("Another tab"));
    expect(f.operations).toEqual(["accept"]);
    second.stop();
  });
  it.each([null, 86400])(
    "matches N and admits before the sealed handoff (expiry=%s)",
    async (duration) => {
      const f = await setup();
      const expiry = duration === null ? null : Math.floor(Date.now() / 1000) + duration;
      await owner.decide(f.id, true, expiry);
      expect(f.operations).toEqual(["accept", "submit", "sealed"]);
      expect(f.read().handoff).toMatchObject({
        cert: { body: { expires_at: expiry, label: "New browser" } },
      });
      expect(owner.read().requests).toEqual([]);
    },
  );
  it.each(["sender", "expired", "commitment"] as const)(
    "never admits an invalid %s request",
    async (invalid) => {
      const f = await setup(false, invalid);
      expect(owner.read().requests).toEqual([]);
      expect(f.operations).not.toContain("submit");
      expect(f.operations).not.toContain("sealed");
    },
  );
  it.each(["expire", "stop"] as const)(
    "withholds handoff when the attempt becomes invalid during admission: %s",
    async (event) => {
      const f = await setup();
      const request = f.request;
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (...args) => {
        const result = await original(...args);
        if ((args[1] as { action?: string })?.action === "submit") {
          if (event === "stop") {
            owner.stop();
          } else {
            vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
          }
        }
        return result;
      });
      await owner.decide(f.id, true);
      expect(f.operations).toEqual(["accept", "submit"]);
      expect(f.read().handoff).toBeUndefined();
      if (event === "expire") {
        expect(owner.read().requests[0]?.error).toContain("revoke");
      }
    },
  );
  it("denies without submitting or sealing", async () => {
    const f = await setup();
    await owner.decide(f.id, false);
    expect(f.operations).toEqual(["accept", "abort"]);
    expect(f.read().submitted).toBeUndefined();
  });
  it("never releases a handoff or resubmits after refused admission", async () => {
    const f = await setup(true);
    await owner.decide(f.id, true);
    await owner.decide(f.id, true);
    expect(f.operations).toEqual(["accept", "submit"]);
    expect(f.read().handoff).toBeUndefined();
    expect(owner.read().requests[0]?.error).toContain("seq conflict");
  });
});
