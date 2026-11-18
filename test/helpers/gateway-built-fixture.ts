import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { GatewayClient } from "../../packages/gateway-client/src/index.js";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import type { GatewayClientRequestOptions } from "../../src/gateway/client.js";

// Fail before a process fixture can rebuild shared dist or fall back to source.
export async function verifyBuiltGatewayHead(repoRoot: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const head = resolveGitHead({ cwd: repoRoot });
  expect(head).toMatch(/^[0-9a-f]{40}$/u);
  await fs.access(path.join(repoRoot, "dist/index.js"));
  signal.throwIfAborted();
  for (const [file, field] of [
    [BUILD_STAMP_FILE, "head"],
    [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
    ["build-info.json", "commit"],
  ] as const) {
    const metadata = JSON.parse(await fs.readFile(path.join(repoRoot, "dist", file), "utf8"));
    signal.throwIfAborted();
    expect(metadata[field], file).toBe(head);
  }
  return head;
}

export function createFixtureRequest(client: Pick<GatewayClient, "request">, signal: AbortSignal) {
  return async <T = Record<string, unknown>>(
    method: string,
    params: unknown = {},
    options: GatewayClientRequestOptions = {},
  ): Promise<T> => {
    signal.throwIfAborted();
    const result = await client.request<T>(method, params, { signal, ...options });
    signal.throwIfAborted();
    return result;
  };
}
