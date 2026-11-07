import {
  computeNodeRedemptionProof,
  deriveInviteProofKey,
  formatIrohEndpointKey,
  MAX_NODE_INVITE_LIFETIME_SECONDS,
  nodeVerificationCode,
  parseStatement,
  signStatement,
  type NodeDescription,
  type NodeJoinLink,
  type SendNodeMailRequest,
  type StatementSigner,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { sleepWithAbort } from "../../packages/retry/src/index.js";
import {
  assessNodeDescriptor,
  nodeDiscoveryCall,
  NodeDiscoveryError,
} from "./openclaw-id-discovery.js";
import type { NodeHostOpenClawIdTarget } from "./openclaw-id-target.js";

/** Mail W's signed declaration, then verify admitted-node evidence before saving or dialing. */
export async function enrollNode(params: {
  link: NodeJoinLink;
  discoveryUrl: string;
  signer: StatementSigner;
  description: NodeDescription;
  previous?: {
    target: NodeHostOpenClawIdTarget;
    persist: (target: NodeHostOpenClawIdTarget) => Promise<unknown>;
  };
  signal?: AbortSignal;
  log: (message: string) => void;
}): Promise<NodeHostOpenClawIdTarget> {
  const deadline = AbortSignal.timeout(MAX_NODE_INVITE_LIFETIME_SECONDS * 1000);
  const signal = AbortSignal.any([deadline, ...(params.signal ? [params.signal] : [])]);
  const peer_key = formatIrohEndpointKey(params.signer.publicKey);
  const parts = { claw_id: params.link.claw_id, invite_id: params.link.invite_id, peer_key };
  const proofKey = await deriveInviteProofKey(params.link.secret);
  let proof: string;
  try {
    proof = await computeNodeRedemptionProof(proofKey, parts);
  } finally {
    proofKey.fill(0);
    params.link.secret.fill(0);
  }
  const redemption = await signStatement(
    "NodeRedemption",
    {
      ...parts,
      description: params.description,
      proof,
      requested_at: Math.floor(Date.now() / 1000),
    },
    params.signer,
  );
  const valid = parseStatement(redemption, "NodeRedemption");
  if (!valid.ok) {
    throw new Error(`Cannot enroll this node's declared command surface: ${valid.detail}`);
  }
  const call = (endpoint: "sendNodeMail" | "getNodeDescriptor", body?: SendNodeMailRequest) =>
    nodeDiscoveryCall({
      origin: params.discoveryUrl,
      signer: params.signer,
      clawId: params.link.claw_id,
      endpoint,
      body,
      signal,
    });
  try {
    // Membership names W, not the approved invitation or description: an already listed W would
    // look approved before the owner decides on this invitation. Refuse before spending it.
    // Accepted gap until signed invitation outcomes (openclaw-607): a still-pending earlier
    // invitation for this W, approved later, also completes this wait. The Gateway still pairs
    // only the description the owner approved, so this cannot widen the node's commands.
    const listed = await call("getNodeDescriptor").then(
      () => true,
      (error: unknown) => {
        if (
          error instanceof NodeDiscoveryError &&
          ["forbidden", "not_found"].includes(error.code)
        ) {
          return false;
        }
        throw error;
      },
    );
    if (listed) {
      throw new Error(
        `This node is already admitted to ${params.link.hostname}; run \`openclaw node run\` to reconnect. To change its commands, ask the owner to remove it on the Access page, then join with a new link.`,
      );
    }
    const code = await nodeVerificationCode(redemption.body);
    params.log(
      `Waiting for approval from ${params.link.hostname}… code ${code.slice(0, 3)}-${code.slice(3)}`,
    );
    await call("sendNodeMail", { to: "gateway", payload: { kind: "node_redemption", redemption } });
    let backoff = 1_000;
    for (;;) {
      signal.throwIfAborted();
      try {
        const raw = await call("getNodeDescriptor");
        const previous = params.previous;
        const sameClaw =
          previous?.target.pin.claw_id === params.link.claw_id &&
          previous.target.pin.root_fp === params.link.root_fp &&
          previous.target.hostname === params.link.hostname;
        const assessed = await assessNodeDescriptor(raw, {
          hostname: params.link.hostname,
          pin: sameClaw
            ? previous.target.pin
            : {
                claw_id: params.link.claw_id,
                root_fp: params.link.root_fp,
                binding_seq: 0,
              },
          discoveryUrl: params.discoveryUrl,
          stored: sameClaw ? previous.target.freshness : undefined,
          peerKey: peer_key,
          joining: true,
        });
        signal.throwIfAborted();
        if (sameClaw) {
          // Refusal must not erase stronger trust learned for an already configured claw.
          await previous.persist(assessed.target);
        }
        if (assessed.error) {
          throw assessed.error;
        }
        signal.throwIfAborted();
        return assessed.target;
      } catch (error) {
        if (
          !(error instanceof NodeDiscoveryError) ||
          !["forbidden", "not_found", "rate_limited", "unavailable"].includes(error.code)
        ) {
          throw error;
        }
        await sleepWithAbort(Math.max(backoff, error.retryAfterMs), signal);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  } catch (error) {
    if (params.signal?.aborted) {
      throw new Error("Node enrollment cancelled.", { cause: error });
    }
    if (deadline.aborted) {
      throw new Error(
        "Node approval timed out. The invitation may have expired or been denied; request a new link from the owner.",
        { cause: error },
      );
    }
    if (error instanceof NodeDiscoveryError && error.code === "code_invalid") {
      throw new Error(
        "Node invitation expired, was denied, or was already used; request a new link from the owner.",
        { cause: error },
      );
    }
    throw error;
  }
}
