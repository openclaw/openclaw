import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assessFreshness,
  descriptorEvidence,
  DISCOVERY_ENDPOINTS,
  DISCOVERY_SIGNATURE_HEADER,
  parseClawDescriptor,
  parseStatement,
  signDiscoveryRequest,
  verifyBindingForPin,
  type ClawPin,
  type FreshnessState,
  type IrohEndpointKey,
  type SendNodeMailRequest,
  type StatementSigner,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import {
  parseNodeHostOpenClawIdTarget,
  type NodeHostOpenClawIdTarget,
} from "./openclaw-id-target.js";

export class OpenClawIdNodeRemovedError extends Error {
  constructor() {
    super("OpenClaw ID node access was removed or is not admitted; re-join this node");
  }
}

/** Only stable codes are surfaced; untrusted response messages may contain secrets or controls. */
export class NodeDiscoveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0,
  ) {
    super(`Discovery request failed (${code})`);
  }
}

export async function nodeDiscoveryCall(params: {
  origin: string;
  signer: StatementSigner;
  clawId: string;
  endpoint: "sendNodeMail" | "getNodeDescriptor";
  body?: SendNodeMailRequest;
  signal: AbortSignal;
}): Promise<unknown> {
  const spec = DISCOVERY_ENDPOINTS[params.endpoint];
  const requestPath = spec.path.replace("{claw_id}", encodeURIComponent(params.clawId));
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
    auditContext: "node-openclaw-id",
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

/** Retain verified facts even on refusal: they must survive a later Discovery replay. */
export async function assessNodeDescriptor(
  raw: unknown,
  context: {
    hostname: string;
    pin: ClawPin;
    discoveryUrl: string;
    stored?: FreshnessState;
    peerKey: IrohEndpointKey;
  },
): Promise<{ target: NodeHostOpenClawIdTarget; error?: Error }> {
  const parsed = isRecord(raw) ? parseClawDescriptor(raw.descriptor) : undefined;
  if (!parsed?.ok || !isRecord(raw)) {
    throw new Error("Discovery returned an invalid node descriptor");
  }
  const evidence = descriptorEvidence(parsed.descriptor);
  const now = Math.floor(Date.now() / 1000);
  const checked = await verifyBindingForPin(evidence, context.pin, { host: context.hostname, now });
  if (!checked.ok) {
    throw new Error(
      `Possible claw substitution: ${checked.code}. Re-join with a new link from the owner.`,
    );
  }
  const freshness = await assessFreshness(
    { snapshot: raw.snapshot },
    {
      binding: checked.binding,
      stored: context.stored ?? null,
      now,
      policy: "enforce",
    },
  );
  const target = parseNodeHostOpenClawIdTarget({
    hostname: context.hostname,
    pin: checked.pin,
    evidence,
    relayUrl: parsed.descriptor.relay_url,
    discoveryUrl: context.discoveryUrl,
    freshness: freshness.state,
  });
  if (!freshness.verdict.ok) {
    return {
      target,
      error: new Error(
        `Cannot verify current claw membership: ${freshness.verdict.code} (${freshness.verdict.detail})`,
      ),
    };
  }
  const snapshot = parseStatement(raw.snapshot, "MembershipSnapshot");
  if (!snapshot.ok || !snapshot.statement.body.node_peer_keys.includes(context.peerKey)) {
    return {
      target,
      error: new OpenClawIdNodeRemovedError(),
    };
  }
  return { target };
}
