import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveIMessageAttachmentRoots } from "../../media/inbound-path-policy.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import type { OutboundChannel } from "./targets.js";

function collectPayloadMediaUrls(payloads: readonly ReplyPayload[]): string[] {
  const urls: string[] = [];
  for (const payload of payloads) {
    if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()) {
      urls.push(payload.mediaUrl.trim());
    }
    for (const mediaUrl of payload.mediaUrls ?? []) {
      if (typeof mediaUrl === "string" && mediaUrl.trim()) {
        urls.push(mediaUrl.trim());
      }
    }
  }
  return urls;
}

function resolveLocalMediaPath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  // Some internal delivery paths surface local files as `MEDIA: /abs/path`.
  const unwrapped = trimmed.replace(/^MEDIA:\s*/i, "").trim();
  if (!unwrapped) {
    return null;
  }
  if (unwrapped.startsWith("file://")) {
    try {
      return path.resolve(fileURLToPath(unwrapped));
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(unwrapped)) {
    return null;
  }
  if (!path.isAbsolute(unwrapped)) {
    return null;
  }
  return path.resolve(unwrapped);
}

function splitSegments(value: string): string[] {
  return value.replaceAll("\\", "/").split("/").filter(Boolean);
}

function concretizeInboundRootPattern(rootPattern: string, candidatePath: string): string | null {
  const rootSegments = splitSegments(rootPattern);
  const candidateSegments = splitSegments(candidatePath);
  if (rootSegments.length === 0 || candidateSegments.length < rootSegments.length) {
    return null;
  }
  const concreteSegments: string[] = [];
  for (let idx = 0; idx < rootSegments.length; idx += 1) {
    const expected = rootSegments[idx];
    const actual = candidateSegments[idx];
    if (!actual) {
      return null;
    }
    if (expected !== "*" && expected !== actual) {
      return null;
    }
    concreteSegments.push(expected === "*" ? actual : expected);
  }
  return `/${concreteSegments.join("/")}`;
}

export function resolveDeliveryMediaLocalRoots(params: {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  payloads: readonly ReplyPayload[];
  accountId?: string;
  agentId?: string;
}): readonly string[] {
  const roots = [...getAgentScopedMediaLocalRoots(params.cfg, params.agentId)];
  if (params.channel !== "imessage") {
    return roots;
  }
  const seen = new Set(roots.map((root) => path.resolve(root)));
  const attachmentRootPatterns = resolveIMessageAttachmentRoots({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  for (const mediaUrl of collectPayloadMediaUrls(params.payloads)) {
    const localPath = resolveLocalMediaPath(mediaUrl);
    if (!localPath) {
      continue;
    }
    for (const rootPattern of attachmentRootPatterns) {
      const concreteRoot = concretizeInboundRootPattern(rootPattern, localPath);
      if (!concreteRoot) {
        continue;
      }
      const resolvedRoot = path.resolve(concreteRoot);
      if (seen.has(resolvedRoot)) {
        continue;
      }
      seen.add(resolvedRoot);
      roots.push(resolvedRoot);
    }
  }
  return roots;
}
