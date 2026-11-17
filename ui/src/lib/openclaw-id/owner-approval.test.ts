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
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createOwnerApproval, type OwnerApproval } from "./owner-approval.ts";
import type { OpenClawIdPeopleLink, OpenClawIdRecoveryUse } from "./types.ts";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Emulates only remote mailbox I/O: the browser approver and both sides' cryptography are real.
const macNode = {
  peer_key: formatIrohEndpointKey(new Uint8Array(32).fill(9)),
  description: {
    display_name: "Mac",
    platform: "macos",
    commands: ["system.run"],
    caps: ["screen"],
  },
};

async function setup(
  refuse = false,
  invalid?: "sender" | "expired" | "commitment" | "node" | "member" | "point",
  node?: typeof macNode,
  memberAccount?: string,
) {
  const root = await generateEd25519Signer();
  const d = await generateEd25519Signer();
  held.d = d;
  held.w = await generateEd25519Signer();
  const n = await generateEd25519Signer();
  const ephN = await generateEphemeralKey();
  if (invalid === "point") {
    ephN.publicKey = new Uint8Array(32);
  }
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
    ...(node ? { node } : {}),
    ...(memberAccount ? { member_account_id: memberAccount } : {}),
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
    ...(memberAccount ? { expires_at: ts + 1800 } : {}),
    ...(invalid === "node" ? { node: { ...macNode, peer_key: start.peer_key } } : {}),
    commit: invalid === "commitment" ? "00".repeat(32) : commit,
  });
  if (invalid === "sender") {
    first.from.device_fp = `fp:${"00".repeat(32)}`;
  }
  if (invalid === "expired") {
    first.received_at = ts - 301;
  }
  const queue: MailboxMessage[] = [first];
  let wake: (() => void) | undefined;
  let reads = 0;
  let shared: Uint8Array;
  let transcript: Uint8Array;
  let matching: string | undefined;
  const operations: string[] = [];
  let submitted: SignedStatement<"MembershipChange"> | undefined;
  let handoff: unknown;
  let members: NonNullable<OpenClawIdPeopleLink["members"]> =
    invalid === "member"
      ? []
      : [{ accountId: "alice", displayName: "Alice", email: "alice@example.test" }];
  const recoveryUses: OpenClawIdRecoveryUse[] = [];
  const mockClient = {
    connected: true,
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
            members,
            recoveryUses,
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
          // A long poll: answers only when new mail arrives.
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        return { status: 200, body: JSON.stringify({ messages: queue.splice(0), cursor: "1" }) };
      }
      if (params.operation === "send") {
        const { payload } = JSON.parse(params.body as string);
        operations.push(
          payload.kind === "member_browser_request" ? `notice:${payload.action}` : payload.step,
        );
        if (payload.step === "accept") {
          if (invalid === "point") {
            queue.push(message("key", { eph_pub: bytesToHex(ephN.publicKey) }));
            return { status: 200, body: "{}" };
          }
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
  const kitUsed = vi.fn();
  const memberDeviceAdded = vi.fn();
  owner = createOwnerApproval(client, vi.fn(), kitUsed, memberDeviceAdded);
  owner.start();
  if (invalid) {
    await vi.waitFor(() =>
      expect(reads).toBeGreaterThanOrEqual(invalid === "commitment" || invalid === "point" ? 3 : 2),
    );
  } else {
    await vi.waitFor(() => expect(owner.read().requests[0]?.code).toBeTruthy());
    expect(owner.read().requests[0]?.code).toBe(matching);
  }
  return {
    client,
    mockClient,
    /** Answers the pending long poll with no new mail. */
    poke: () => wake?.(),
    reads: () => reads,
    removeMember: () => {
      members = [];
    },
    request: mockClient.request,
    operations,
    read: () => ({ submitted, handoff }),
    id: start.request_id,
    kitUsed,
    memberDeviceAdded,
    async replacement(offset = 1) {
      const receivedAt = ts + offset;
      const device = await generateEd25519Signer();
      const next = {
        ...start,
        request_id: "78".repeat(16),
        device_pub: formatEd25519PublicKey(device.publicKey),
        peer_key: formatIrohEndpointKey(device.publicKey),
      };
      const before = reads;
      queue.push({
        ...first,
        received_at: receivedAt,
        from: { ...first.from, device_fp: await fingerprint(next.device_pub) },
        payload: {
          kind: "enrollment",
          step: "start",
          request_id: next.request_id,
          data: {
            ...next,
            expires_at: receivedAt + 1800,
            commit: await sasCommitment(ephN.publicKey, next),
          },
        },
      });
      wake?.();
      await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
      return next.request_id;
    },
    recoveryUses,
    members,
    notice: (
      ref: string,
      event: "kit_used" | "member_device_added" = "kit_used",
      noticeClawId = clawId,
    ) => {
      queue.push({
        ...message("start", {}),
        claw_id: noticeClawId,
        message_id: "78".repeat(16),
        payload: { kind: "notice", event, ref },
      });
      wake?.();
    },
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
  it("adds the existing member only after the owner enters the matching code", async () => {
    const f = await setup(false, undefined, undefined, "alice");
    expect(owner.read().requests[0]?.member).toMatchObject({
      name: "Alice",
      email: "alice@example.test",
    });
    await owner.decide(f.id, true, null, "wrong");
    expect(f.operations).toEqual(["accept"]);
    expect(owner.read().requests[0]?.error).toContain("six-digit");
    await owner.decide(f.id, true, null, owner.read().requests[0]?.code);
    expect(f.operations).toEqual(["accept", "submit", "sealed"]);
    expect(f.read().submitted?.body.target).toMatchObject({
      op: "add_member_device",
      account_id: "alice",
      label: "New browser",
    });
    expect(f.read().submitted?.body.target).not.toHaveProperty("role");
    expect(f.read().handoff).toMatchObject({ cert: null });
  });
  it("replaces an abandoned member attempt with a newer browser request", async () => {
    const f = await setup(false, undefined, undefined, "alice");
    const id = await f.replacement();
    expect(owner.read().requests.map((request) => request.id)).toEqual([id]);
    await owner.decide(f.id, true, null, "000000");
    expect(f.operations).toEqual(["accept", "accept"]);
  });
  it("keeps the newer member attempt when an older browser request arrives late", async () => {
    const f = await setup(false, undefined, undefined, "alice");
    await f.replacement(-1);
    expect(owner.read().requests.map((request) => request.id)).toEqual([f.id]);
    expect(f.operations).toEqual(["accept"]);
  });
  it("does not replace a member admission already being submitted", async () => {
    const f = await setup(false, undefined, undefined, "alice");
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[1].action === "submit") {
        admitted.resolve();
        await release.promise;
      }
      return original(...args);
    });
    const deciding = owner.decide(f.id, true, null, owner.read().requests[0]!.code);
    try {
      await admitted.promise;
      await f.replacement();
      expect(owner.read().requests.map((request) => request.id)).toEqual([f.id]);
      expect(owner.read().requests[0]?.busy).toBe(true);
    } finally {
      release.resolve();
      await deciding;
    }
    expect(f.operations).toEqual(["accept", "submit", "sealed"]);
  });
  it("directs a member's uncertain sealed handoff to their devices in Access", async () => {
    const f = await setup(false, undefined, undefined, "alice");
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (
        args[1].operation === "send" &&
        JSON.parse(args[1].body as string).payload.step === "sealed"
      ) {
        throw new Error("Mailbox unavailable");
      }
      return original(...args);
    });
    await owner.decide(f.id, true, null, owner.read().requests[0]!.code);
    expect(f.read().submitted?.body.target.op).toBe("add_member_device");
    expect(owner.read().requests[0]).toMatchObject({ uncertain: true, busy: true });
    expect(owner.read().requests[0]?.error).toContain("member’s devices in Access");
    expect(owner.read().requests[0]?.error).not.toContain("Your devices");
  });
  it("never presents a claim for a nonmember", async () => {
    const f = await setup(false, "member", undefined, "stranger");
    expect(owner.read().requests).toEqual([]);
    expect(f.operations).toEqual([]);
  });
  it("refuses a member removed after comparison before any grant is sent", async () => {
    const f = await setup(false, undefined, undefined, "alice");
    const code = owner.read().requests[0]?.code;
    f.removeMember();
    await owner.decide(f.id, true, null, code);
    expect(f.operations).toEqual(["accept"]);
    expect(owner.read().requests[0]?.error).toContain("no longer available");
  });
  it("retires a denied member request before a failed display-notice cleanup", async () => {
    const f = await setup(false, undefined, undefined, "alice");
    const code = owner.read().requests[0]?.code;
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      if (params.operation === "send") {
        const { payload } = JSON.parse(params.body as string);
        if (payload.kind === "member_browser_request") {
          expect(f.operations).toEqual(["accept", "abort"]);
          throw new Error("notice transport failed");
        }
      }
      return request(method, params);
    });
    await owner.decide(f.id, false);
    expect(f.operations).toEqual(["accept", "abort"]);
    expect(owner.read().requests).toEqual([]);
    await owner.decide(f.id, true, null, code);
    expect(f.read().submitted).toBeUndefined();
  });
  it("denies a member request without a membership write", async () => {
    const f = await setup(false, undefined, undefined, "alice");
    await owner.decide(f.id, false);
    expect(f.operations).toEqual(["accept", "abort", "notice:cancel"]);
    expect(f.read().submitted).toBeUndefined();
  });
  it("approves an app's node in the same change, bound by the compared number", async () => {
    const f = await setup(false, undefined, macNode);
    expect(owner.read().requests[0]?.tools).toEqual({ commands: ["system.run"], caps: ["screen"] });
    await owner.decide(f.id, true);
    expect(f.operations).toEqual(["accept", "submit", "sealed"]);
    expect(f.read().submitted?.body.target).toMatchObject({
      op: "add_owner_device",
      node: { ...macNode, label: "New browser" },
    });
  });
  it("rejects a low-order point per request and keeps reading owner notices", async () => {
    const f = await setup(false, "point", undefined, "alice");
    expect(owner.read().requests).toEqual([]);
    expect(owner.read().error).toBeNull();
    f.notice("fp:local");
    await vi.waitFor(() => expect(f.kitUsed).toHaveBeenCalledWith("local"));
    expect(f.operations).toEqual(["accept"]);
  });
  it("names the device in a kit-used notice", async () => {
    const f = await setup();
    f.notice("fp:local");
    await vi.waitFor(() => expect(f.kitUsed).toHaveBeenCalledWith("local"));
  });
  it("surfaces member-device notices only for this claw without treating them as approvals", async () => {
    const f = await setup();
    f.notice("fp:other", "member_device_added", "ab".repeat(16));
    f.notice("fp:member-peer", "member_device_added");
    await vi.waitFor(() => expect(f.memberDeviceAdded).toHaveBeenCalledTimes(1));
    expect(f.memberDeviceAdded).toHaveBeenCalledWith(undefined);
    expect(f.kitUsed).not.toHaveBeenCalled();
    expect(f.operations).toEqual(["accept"]);
    expect(owner.read().requests).toHaveLength(1);
  });
  it.each(["member_recovery_kit", "invite", "member_device", "revoked", "removed"] as const)(
    "classifies reused peer keys by current admission, not retained kit history: %s",
    async (admission) => {
      const f = await setup();
      const use: OpenClawIdRecoveryUse = {
        seq: 9,
        accountId: "member-mira",
        memberName: "Mira Example",
        deviceLabel: "Current browser",
        peerKey: `iroh:${"12".repeat(32)}`,
        peerFp: "fp:recovered-peer",
        usedAt: 1_800_000_000,
      };
      f.recoveryUses.push({ ...use, seq: 3, deviceLabel: "Former browser" }, use);
      if (admission !== "removed") {
        f.members.push({
          accountId: use.accountId,
          displayName: use.memberName,
          email: null,
          devices:
            admission === "revoked"
              ? []
              : [
                  {
                    peerKey: use.peerKey,
                    approvedBy:
                      admission === "invite"
                        ? { kind: admission, invite_id: "new-invite" }
                        : { kind: admission, device_fp: `fp:${"34".repeat(32)}` },
                  },
                ],
        });
      }
      f.notice(use.peerFp, "member_device_added");
      await vi.waitFor(() => expect(f.memberDeviceAdded).toHaveBeenCalledTimes(1));
      expect(f.memberDeviceAdded).toHaveBeenCalledWith(
        admission === "member_recovery_kit" ? use : undefined,
      );
      expect(f.kitUsed).not.toHaveBeenCalled();
      expect(f.operations).toEqual(["accept"]);
    },
  );
  it("approves a browser without a node", async () => {
    const f = await setup();
    expect(owner.read().requests[0]?.tools).toBeUndefined();
    await owner.decide(f.id, true);
    expect(f.read().submitted?.body.target).not.toHaveProperty("node");
  });
  it.each(["sender", "expired", "commitment", "node"] as const)(
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
    expect(owner.read().requests[0]?.uncertain).toBe(true);
  });
  it("publishes expiry while mailbox receive is pending and keeps only an inactive number", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
    const expires = Date.now() + 300_000;
    const f = await setup();
    const code = owner.read().requests[0]?.code;
    const changed = vi.fn();
    owner.subscribe(changed);
    await vi.advanceTimersByTimeAsync(expires - Date.now());
    expect(changed).toHaveBeenCalled();
    expect(owner.read().requests).toEqual([
      expect.objectContaining({ id: f.id, label: "New browser", code, expired: true }),
    ]);
    await owner.decide(f.id, true);
    await owner.decide(f.id, false);
    expect(f.operations).toEqual(["accept"]);
    owner.stop();
    expect(owner.read().requests).toEqual([]);
  });
  it("keeps member approval live past five minutes and retires it at the original thirty-minute bound", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
    const expires = Date.now() + 1_800_000;
    const f = await setup(false, undefined, undefined, "alice");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(owner.read().requests[0]).toMatchObject({ id: f.id, member: { name: "Alice" } });
    expect(owner.read().requests[0]?.expired).not.toBe(true);
    await vi.advanceTimersByTimeAsync(expires - Date.now());
    expect(owner.read().requests[0]).toMatchObject({ id: f.id, expired: true });
    await owner.decide(f.id, true, null, "482917");
    expect(f.operations).toEqual(["accept"]);
    expect(f.read().submitted).toBeUndefined();
  });
});

describe("owner approval across transport failures", () => {
  const unavailable = () =>
    new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "Owner-device mail could not be delivered",
      retryable: true,
    });
  // The claw lists N once the submitted change applied, as the Gateway reports after admission.
  const admitOnSubmit = (f: Awaited<ReturnType<typeof setup>>) => {
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const result = await original(...args);
      const submitted = f.read().submitted;
      if (args[1].operation === "context" && submitted?.body.target.op === "add_owner_device") {
        const link = (result as { link: OpenClawIdPeopleLink }).link;
        const cert = submitted.body.target.cert;
        link.ownerDevices = [
          ...(link.ownerDevices ?? []),
          { ...link.ownerDevices![0]!, devicePub: cert.body.device_pub, deviceFp: "fp:new", cert },
        ];
      }
      return result;
    });
    return original;
  };

  // The first sealed send fails as the connection drops; the claw has already applied the change.
  const dropFirstSealed = (f: Awaited<ReturnType<typeof setup>>, onContext = () => {}) => {
    admitOnSubmit(f);
    const admitted = f.request.getMockImplementation()!;
    let dropped = false;
    f.request.mockImplementation(async (...args) => {
      if (
        args[1].operation === "send" &&
        JSON.parse(args[1].body as string).payload.step === "sealed" &&
        !dropped
      ) {
        dropped = true;
        f.mockClient.connected = false;
        throw new Error("gateway closed (1006): ");
      }
      if (dropped && args[1].operation === "context") {
        onContext();
      }
      return admitted(...args);
    });
    return admitted;
  };

  it.each([false, true])(
    "finishes an admitted approval whose sealed handoff was lost to a dropped connection (moved client: %s)",
    async (moved) => {
      const f = await setup();
      const admitted = dropFirstSealed(f);
      await owner.decide(f.id, true);
      expect(owner.read().requests[0]).toMatchObject({ uncertain: true });
      const next = { connected: true, request: vi.fn(admitted) };
      if (moved) {
        owner.suspend();
        owner.resume(next as unknown as GatewayBrowserClient);
      } else {
        f.mockClient.connected = true;
      }
      f.poke();
      await vi.waitFor(() => expect(f.read().handoff).toBeDefined());
      expect(f.operations.filter((op) => op === "submit")).toHaveLength(1);
      expect(owner.read().requests).toEqual([]);
      expect(next.request.mock.calls.some(([, p]) => p.operation === "send")).toBe(moved);
    },
  );

  it("holds mail and decisions while a reconnected client is being admitted", async () => {
    const f = await setup();
    owner.suspend();
    const before = f.reads();
    f.poke();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(f.reads()).toBe(before);
    await owner.decide(f.id, true);
    expect(f.operations).not.toContain("submit");
    expect(owner.read().requests[0]?.error).toContain("Reconnecting");
    owner.resume(f.client);
    await vi.waitFor(() => expect(f.reads()).toBeGreaterThan(before));
    await owner.decide(f.id, true);
    expect(f.read().handoff).toBeDefined();
  });

  it("withholds a recovered handoff when the attempt expires during the admission check", async () => {
    const f = await setup();
    dropFirstSealed(f, () => vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000));
    await owner.decide(f.id, true);
    f.poke();
    const contexts = () => f.request.mock.calls.filter(([, p]) => p.operation === "context").length;
    await vi.waitFor(() => expect(contexts()).toBeGreaterThan(2));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(f.read().handoff).toBeUndefined();
  });

  it("never sends a handoff for an uncertain submit the claw did not apply", async () => {
    const f = await setup(true);
    await owner.decide(f.id, true);
    const before = f.reads();
    f.poke();
    await vi.waitFor(() => expect(f.reads()).toBeGreaterThan(before));
    expect(f.operations).toEqual(["accept", "submit"]);
    expect(f.read().handoff).toBeUndefined();
  });

  it("keeps reading mail after an unavailable relay instead of waiting for Retry", async () => {
    const f = await setup();
    const original = f.request.getMockImplementation()!;
    let failures = 1;
    f.request.mockImplementation(async (...args) => {
      if (args[1].operation === "receive" && failures > 0) {
        failures -= 1;
        throw unavailable();
      }
      return original(...args);
    });
    f.poke();
    await vi.waitFor(() => expect(owner.read().error).toContain("could not be delivered"));
    const before = f.reads();
    await vi.waitFor(() => expect(f.reads()).toBeGreaterThan(before), { timeout: 3_000 });
    f.poke();
    await vi.waitFor(() => expect(owner.read().error).toBeNull());
    await owner.decide(f.id, true);
    expect(f.read().handoff).toBeDefined();
  });

  it("stops on a refusal and leaves it to an explicit Retry", async () => {
    const f = await setup();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[1].operation === "receive") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Only an active owner device can use device mail",
        });
      }
      return original(...args);
    });
    f.poke();
    await vi.waitFor(() => expect(owner.read().error).toContain("Only an active owner"));
    const reads = f.request.mock.calls.filter(([, p]) => p.operation === "receive").length;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500);
    });
    expect(f.request.mock.calls.filter(([, p]) => p.operation === "receive")).toHaveLength(reads);
  });
});
