import http from "node:http";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  buildNodeJoinLink,
  computeNodeRedemptionProof,
  deriveInviteProofKey,
  fingerprint,
  formatIrohEndpointKey,
  nodeVerificationCode,
  parseNodeJoinLink,
  parseStatement,
  signStatement,
  verifyDiscoveryRequest,
  verifyNodeRedemptionSignature,
  type GetNodeDescriptorResponse,
  type NodeDescription,
  type SendNodeMailRequest,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { buildWorld } from "../../packages/openclaw-id-protocol/src/testing/world.js";
import { sleepWithAbort } from "../../packages/retry/src/index.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { enrollNode } from "./openclaw-id-enrollment.js";

vi.mock("../../packages/retry/src/index.js", async (original) => ({
  ...(await original<typeof import("../../packages/retry/src/index.js")>()),
  sleepWithAbort: vi.fn(async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted()),
}));
const world = await buildWorld();
const secret = new Uint8Array(32).fill(42);
const description: NodeDescription = {
  display_name: "Restricted node",
  platform: "linux",
  commands: ["system.run"],
  caps: ["system"],
};
const linkText = buildNodeJoinLink({
  invite_id: "12".repeat(16),
  secret,
  claw_id: world.binding.body.claw_id,
  root_fp: await fingerprint(world.rootPub),
  hostname: world.binding.body.hostname,
  relay_url: "https://relay.example/",
});
let receipt: SendNodeMailRequest | undefined;
let descriptor: GetNodeDescriptorResponse;
let refusal: string | undefined;
let reads = 0;
let listedBeforeMail = false;
let signatureErrors: string[] = [];
let server: Awaited<ReturnType<typeof reserveTestPortListener<http.Server>>>;
let origin: string;

beforeAll(async () => {
  server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks);
          const signature = await verifyDiscoveryRequest(
            { method: req.method!, path: req.url!, body },
            String(req.headers["openclaw-signature"]),
            Math.floor(Date.now() / 1000),
          );
          if (!signature.ok || signature.keyid !== world.invitee.pub || req.headers.authorization) {
            signatureErrors.push("invalid node request authentication");
          }
          res.setHeader("content-type", "application/json");
          if (req.method === "POST") {
            expect(req.url).toBe(`/v1/claws/${world.binding.body.claw_id}/mailbox/node`);
            receipt = JSON.parse(body.toString()) as SendNodeMailRequest;
            if (refusal) {
              res.writeHead(410).end(JSON.stringify({ error: { code: refusal } }));
              return;
            }
            res.end(
              JSON.stringify({
                message_id: "fixture",
                expires_at: Math.floor(Date.now() / 1000) + 600,
              }),
            );
          } else {
            expect(req.url).toBe(`/v1/claws/${world.binding.body.claw_id}/node/descriptor`);
            reads++;
            // Unlisted W is refused until approval; the first poll after mail is still pending.
            if ((!receipt && !listedBeforeMail) || reads === 2) {
              res.writeHead(403).end(JSON.stringify({ error: { code: "forbidden" } }));
              return;
            }
            res.end(JSON.stringify(descriptor));
          }
        })().catch((error: unknown) => {
          signatureErrors.push(String(error));
          res.writeHead(500).end("{}");
        });
      }),
  });
  origin = `http://127.0.0.1:${server.claim.port}`;
});
afterAll(async () => {
  await server.releaseListener();
  await server.claim.release();
});
beforeEach(async () => {
  receipt = undefined;
  refusal = undefined;
  reads = 0;
  listedBeforeMail = false;
  signatureErrors = [];
  vi.clearAllMocks();
  const now = Math.floor(Date.now() / 1000);
  descriptor = {
    descriptor: {
      v: 1,
      claw_id: world.binding.body.claw_id,
      transport: "iroh",
      relay_url: "https://relay.example/",
      root_pub: world.rootPub,
      binding: world.binding,
      published_at: now,
    },
    snapshot: await signStatement(
      "MembershipSnapshot",
      {
        claw_id: world.binding.body.claw_id,
        seq: 1,
        binding_seq: world.binding.body.binding_seq,
        owner_devices: [],
        owner_peer_keys: [],
        node_peer_keys: [formatIrohEndpointKey(world.invitee.signer.publicKey)],
        members: [],
        protocols: { statement: [1], descriptor: [1] },
        issued_at: now,
      },
      world.gateway.signer,
    ),
  };
});
const join = (log = vi.fn()) =>
  enrollNode({
    link: parseNodeJoinLink(linkText)!,
    discoveryUrl: origin,
    signer: world.invitee.signer,
    description,
    log,
  });

test("signs accountless mail, waits for approval, and returns only verified pinned target", async () => {
  const log = vi.fn();
  const target = await join(log);
  expect(signatureErrors).toEqual([]);
  expect(receipt?.to).toBe("gateway");
  const redemption = receipt!.payload.redemption;
  expect(parseStatement(redemption, "NodeRedemption").ok).toBe(true);
  expect((await verifyNodeRedemptionSignature(redemption)).ok).toBe(true);
  expect(redemption.body.description).toEqual(description);
  const proofKey = await deriveInviteProofKey(secret);
  expect(redemption.body.proof).toBe(
    await computeNodeRedemptionProof(proofKey, {
      claw_id: redemption.body.claw_id,
      invite_id: redemption.body.invite_id,
      peer_key: redemption.body.peer_key,
    }),
  );
  expect(JSON.stringify(receipt)).not.toContain(Buffer.from(secret).toString("base64url"));
  const code = await nodeVerificationCode(redemption.body);
  expect(log).toHaveBeenCalledWith(
    `Waiting for approval from ${target.hostname}… code ${code.slice(0, 3)}-${code.slice(3)}`,
  );
  expect(sleepWithAbort).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
  expect(target.discoveryUrl).toBe(origin);
  expect(target.pin).toEqual({
    claw_id: world.binding.body.claw_id,
    root_fp: await fingerprint(world.rootPub),
    binding_seq: world.binding.body.binding_seq,
  });
});
test("refuses a Discovery root substitution", async () => {
  descriptor.descriptor.root_pub = world.mallory.pub;
  await expect(join()).rejects.toThrow("Possible claw substitution: root_mismatch");
});
test("refuses a replayed stale snapshot", async () => {
  descriptor.snapshot = await signStatement(
    "MembershipSnapshot",
    { ...descriptor.snapshot.body, issued_at: 1 },
    world.gateway.signer,
  );
  await expect(join()).rejects.toThrow("freshness_unavailable");
});
test("refuses membership that omits W even when Discovery grants a descriptor read", async () => {
  descriptor.snapshot = await signStatement(
    "MembershipSnapshot",
    { ...descriptor.snapshot.body, node_peer_keys: [] },
    world.gateway.signer,
  );
  await expect(join()).rejects.toThrow("not admitted");
});
test("reports expired or denied invitation without exposing the link", async () => {
  refusal = "code_invalid";
  await expect(join()).rejects.toThrow("expired, was denied, or was already used");
  expect(reads).toBe(1);
});

test("refuses re-enrollment while old membership still lists W, before spending the invite", async () => {
  listedBeforeMail = true;
  await expect(join()).rejects.toThrow("already admitted");
  expect(receipt).toBeUndefined();
});

test("refuses another claw even when the pinned root signed its binding", async () => {
  const claw_id = "34".repeat(16);
  descriptor.descriptor.claw_id = claw_id;
  descriptor.descriptor.binding = await signStatement(
    "ServerBinding",
    { ...world.binding.body, claw_id },
    world.root,
  );
  await expect(join()).rejects.toThrow("Possible claw substitution: wrong_claw");
});

test("cancellation while waiting stops before another descriptor read", async () => {
  const abort = new AbortController();
  vi.mocked(sleepWithAbort).mockImplementationOnce(async () => {
    abort.abort();
    abort.signal.throwIfAborted();
  });
  await expect(
    enrollNode({
      link: parseNodeJoinLink(linkText)!,
      discoveryUrl: origin,
      signer: world.invitee.signer,
      description,
      signal: abort.signal,
      log: vi.fn(),
    }),
  ).rejects.toThrow("cancelled");
  expect(reads).toBe(2);
});

test("preserves the highest verified binding sequence when rejoining the same claw", async () => {
  const link = parseNodeJoinLink(linkText)!;
  await expect(
    enrollNode({
      link,
      discoveryUrl: origin,
      signer: world.invitee.signer,
      description,
      log: vi.fn(),
      previousPin: {
        claw_id: link.claw_id,
        root_fp: link.root_fp,
        binding_seq: world.binding.body.binding_seq + 1,
      },
    }),
  ).rejects.toThrow("rollback");
});
