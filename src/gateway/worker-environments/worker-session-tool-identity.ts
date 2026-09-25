import { sha256Base64Url, sha256HexPrefixCore } from "../../infra/crypto-digest.js";

export function computeRequestDigest(value: unknown): string {
  return sha256Base64Url(`openclaw.worker-session-tool-request.v1\0${JSON.stringify(value)}`);
}

export function workerSessionOperationKey(operationSeed: string, purpose: string): string {
  return sha256Base64Url(`openclaw.worker-session-tool-operation.v1\0${operationSeed}\0${purpose}`);
}

export function childSessionKey(operationSeed: string, targetAgentId: string): string {
  return `agent:${targetAgentId}:dashboard:cloud-${sha256HexPrefixCore(
    `openclaw.worker-session-tool-operation.v1\0${operationSeed}\0child-session`,
    32,
  )}`;
}
