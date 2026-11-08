import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assessFreshness,
  computeNodeRedemptionProof,
  deriveInviteProofKey,
  descriptorEvidence,
  DISCOVERY_ENDPOINTS,
  DISCOVERY_SIGNATURE_HEADER,
  formatIrohEndpointKey,
  MAX_NODE_INVITE_LIFETIME_SECONDS,
  nodeVerificationCode,
  parseClawDescriptor,
  parseStatement,
  signDiscoveryRequest,
  signStatement,
  verifyBindingForPin,
  type ClawPin,
  type NodeDescription,
  type NodeJoinLink,
  type SendNodeMailRequest,
  type StatementSigner,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { sleepWithAbort } from "../../packages/retry/src/index.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import {
  parseNodeHostOpenClawIdTarget,
  type NodeHostOpenClawIdTarget,
} from "./openclaw-id-target.js";

/** Only stable codes are surfaced; untrusted response messages may contain secrets or controls. */
class NodeDiscoveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0,
  ) {
    super(`Discovery request failed (${code})`);
  }
}

async function discoveryCall(params: {
  origin: string;
  signer: StatementSigner;
  link: NodeJoinLink;
  endpoint: "sendNodeMail" | "getNodeDescriptor";
  body?: SendNodeMailRequest;
  signal: AbortSignal;
}): Promise<unknown> {
  const spec = DISCOVERY_ENDPOINTS[params.endpoint];
  const requestPath = spec.path.replace("{claw_id}", encodeURIComponent(params.link.claw_id));
  const bytes = new TextEncoder().encode(params.body ? JSON.stringify(params.body) : "");
  const signature = await signDiscoveryRequest(
    {
      method: spec.method,
      path: requestPath,
      body: bytes,
      ts: Math.floor(Date.now() / 1000),
    },
    params.signer,
  );
  params.signal.throwIfAborted();
  const host = new URL(params.origin).hostname;
  const { response, release } = await fetchWithSsrFGuard({
    url: new URL(requestPath, params.origin).href,
    auditContext: "node-openclaw-id-enrollment",
    signal: params.signal,
    timeoutMs: 15_000,
    maxRedirects: 0,
    requireHttps: new URL(params.origin).protocol === "https:",
    policy: { allowPrivateNetwork: true, allowedHostnames: [host], hostnameAllowlist: [host] },
    init: {
      method: spec.method,
      headers: { [DISCOVERY_SIGNATURE_HEADER]: signature, "content-type": "application/json" },
      ...(params.body ? { body: bytes } : {}),
    },
    capture: { sensitiveRequestHeaderNames: [DISCOVERY_SIGNATURE_HEADER] },
  });
  try {
    const buffer = await readResponseWithLimit(response, 1024 * 1024, { signal: params.signal });
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    if (!response.ok) {
      const error = isRecord(raw) && isRecord(raw.error) ? raw.error : undefined;
      const code =
        typeof error?.code === "string" && /^[a-z_]{1,40}$/.test(error.code)
          ? error.code
          : "unavailable";
      const retry =
        typeof error?.retry_after === "number" && Number.isFinite(error.retry_after)
          ? Math.max(0, error.retry_after * 1000)
          : 0;
      throw new NodeDiscoveryError(code, retry);
    }
    return raw;
  } finally {
    await release();
  }
}

/** Mail W's signed declaration, then verify admitted-node evidence before saving or dialing. */
export async function enrollNode(params: {
  link: NodeJoinLink;
  discoveryUrl: string;
  signer: StatementSigner;
  description: NodeDescription;
  previousPin?: ClawPin;
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
    discoveryCall({
      origin: params.discoveryUrl,
      signer: params.signer,
      link: params.link,
      endpoint,
      body,
      signal,
    });
  try {
    // Membership names W, not the approved invitation or description: an already listed W would
    // look approved before the owner decides on this invitation. Refuse before spending it.
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
        if (!isRecord(raw)) {
          throw new Error("Discovery returned an invalid node descriptor");
        }
        const parsed = parseClawDescriptor(raw.descriptor);
        if (!parsed.ok) {
          throw new Error("Discovery returned an invalid node descriptor");
        }
        const evidence = descriptorEvidence(parsed.descriptor);
        const checked = await verifyBindingForPin(
          evidence,
          {
            claw_id: params.link.claw_id,
            root_fp: params.link.root_fp,
            binding_seq:
              params.previousPin?.claw_id === params.link.claw_id &&
              params.previousPin.root_fp === params.link.root_fp
                ? params.previousPin.binding_seq
                : 0,
          },
          { host: params.link.hostname, now: Math.floor(Date.now() / 1000) },
        );
        if (!checked.ok) {
          throw new Error(
            `Possible claw substitution: ${checked.code}. Do not approve; obtain a new link from the owner.`,
          );
        }
        const freshness = await assessFreshness(
          { snapshot: raw.snapshot },
          {
            binding: checked.binding,
            stored: null,
            now: Math.floor(Date.now() / 1000),
            policy: "enforce",
          },
        );
        if (!freshness.verdict.ok) {
          throw new Error(`Cannot verify current claw membership: ${freshness.verdict.code}`);
        }
        const snapshot = parseStatement(raw.snapshot, "MembershipSnapshot");
        if (!snapshot.ok || !snapshot.statement.body.node_peer_keys.includes(peer_key)) {
          throw new Error(
            "This node is not admitted in the verified claw membership; re-join this node.",
          );
        }
        signal.throwIfAborted();
        return parseNodeHostOpenClawIdTarget({
          hostname: params.link.hostname,
          pin: checked.pin,
          evidence,
          relayUrl: parsed.descriptor.relay_url,
          discoveryUrl: params.discoveryUrl,
        });
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
      throw new Error("Node enrollment cancelled; no target was saved.", { cause: error });
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
