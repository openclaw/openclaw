import { createHmac, timingSafeEqual } from "node:crypto";

const SLACK_SIGNATURE_VERSION = "v0";

/**
 * Maximum age of a Slack request before it is rejected as potentially replayed.
 * Slack recommends 5 minutes.
 */
const SLACK_TIMESTAMP_MAX_AGE_MS = 5 * 60 * 1000;

export type SlackSignatureVerificationResult =
  | { ok: true }
  | { ok: false; reason: string; statusCode: 400 | 401 };

/**
 * Verify a Slack request signature.
 *
 * Implements the verification algorithm described at:
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * @param signingSecret - The Slack app signing secret (channels.slack.signingSecret)
 * @param body          - The raw request body as a UTF-8 string (must be read before calling)
 * @param timestamp     - Value of the X-Slack-Request-Timestamp header
 * @param signature     - Value of the X-Slack-Signature header (format: "v0=<hex>")
 * @param nowMs         - Current time in milliseconds (injectable for testing)
 */
export function verifySlackRequestSignature(params: {
  signingSecret: string;
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
}): SlackSignatureVerificationResult {
  const { signingSecret, body, timestamp, signature, nowMs = Date.now() } = params;

  if (!timestamp) {
    return { ok: false, reason: "Missing X-Slack-Request-Timestamp header", statusCode: 400 };
  }
  if (!signature) {
    return { ok: false, reason: "Missing X-Slack-Signature header", statusCode: 400 };
  }

  // Reject requests with a timestamp too far in the past or future (replay protection).
  // CWE-294: Authentication Bypass by Capture-replay
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: "Invalid X-Slack-Request-Timestamp value", statusCode: 400 };
  }
  if (Math.abs(nowMs - timestampMs) > SLACK_TIMESTAMP_MAX_AGE_MS) {
    return {
      ok: false,
      reason: "X-Slack-Request-Timestamp is too old or too far in the future",
      statusCode: 400,
    };
  }

  // Compute the expected signature.
  // Slack signature base string: "v0:{timestamp}:{body}"
  const baseString = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${body}`;
  const hmacHex = createHmac("sha256", signingSecret).update(baseString).digest("hex");
  const expected = `${SLACK_SIGNATURE_VERSION}=${hmacHex}`;

  // Constant-time comparison to prevent timing oracle attacks.
  // CWE-208: Observable Timing Discrepancy
  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  if (
    expectedBuf.length !== signatureBuf.length ||
    !timingSafeEqual(expectedBuf, signatureBuf)
  ) {
    return { ok: false, reason: "Invalid X-Slack-Signature", statusCode: 401 };
  }

  return { ok: true };
}
