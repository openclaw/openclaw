import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Verify Slack request signature (HMAC-SHA256)
 * Based on: https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(params: {
  signingSecret: string;
  body: string;
  signature: string;
  timestamp: number;
}): boolean {
  const { signingSecret, body, signature, timestamp } = params;

  // Check timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 5 * 60) {
    return false;
  }

  // Compute HMAC-SHA256
  const hmac = crypto.createHmac("sha256", signingSecret);
  const baseString = `v0:${timestamp}:${body}`;
  hmac.update(baseString);
  const computedSignature = `v0=${hmac.digest("hex")}`;

  // Compare signatures using constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computedSignature),
      Buffer.from(signature),
    );
  } catch {
    // timingSafeEqual throws RangeError if buffer lengths differ
    return false;
  }
}

/**
 * Extract signature and timestamp from request headers
 */
export function extractSlackSignatureHeaders(req: IncomingMessage): {
  signature?: string;
  timestamp?: number;
} {
  const signature = Array.isArray(req.headers["x-slack-signature"])
    ? req.headers["x-slack-signature"][0]
    : req.headers["x-slack-signature"];

  const timestampHeader = Array.isArray(req.headers["x-slack-request-timestamp"])
    ? req.headers["x-slack-request-timestamp"][0]
    : req.headers["x-slack-request-timestamp"];

  const timestamp = timestampHeader ? Number.parseInt(timestampHeader, 10) : undefined;

  return { signature, timestamp };
}
