// Gateway hook test fixtures.
// Builds hook request, payload, and transform fixtures for tests.
import fs from "node:fs/promises";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { expect } from "vitest";
import type { HookMappingConfig } from "../config/types.hooks.js";
import type { HooksConfigResolved } from "./hooks.js";

export const HOOK_TOKEN = "hook-secret";

/** Creates the default resolved hook config used by gateway hook tests. */
export function createHooksConfig(): HooksConfigResolved {
  return {
    basePath: "/hooks",
    token: HOOK_TOKEN,
    maxBodyBytes: 1024,
    maxBodyBytesByPath: new Map(),
    mappings: [],
    agentPolicy: {
      defaultAgentId: "main",
      globalSessionStoreOwner: { kind: "none" },
      knownAgentIds: new Set(["main"]),
      allowedAgentIds: undefined,
    },
    sessionPolicy: {
      allowRequestSessionKey: false,
      defaultSessionKey: undefined,
      allowedSessionKeyPrefixes: undefined,
    },
  };
}

/** Builds an IncomingMessage-shaped request for hook handler tests. */
export function createGatewayRequest(params: {
  path: string;
  authorization?: string;
  method?: string;
  remoteAddress?: string;
  host?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: params.host ?? "localhost:18789",
    ...params.headers,
  };
  if (params.authorization) {
    headers.authorization = params.authorization;
  }
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: params.remoteAddress ?? "127.0.0.1" });
  return Object.assign(new IncomingMessage(socket), {
    method: params.method ?? "GET",
    url: params.path,
    headers,
  });
}

export function requireNonEmptyString(value: string | null | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export async function postHook(
  port: number,
  route: string,
  body: Record<string, unknown> | string,
  options: { token?: string | null; headers?: Record<string, string>; status?: number } = {},
): Promise<Response> {
  const { token = HOOK_TOKEN, headers, status = 200 } = options;
  const response = await fetch(`http://127.0.0.1:${port}/hooks/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  expect(response.status).toBe(status);
  return response;
}

export async function postAgentHookWithIdempotency(
  port: number,
  idempotencyKey: string,
  headers?: Record<string, string>,
) {
  const response = await postHook(
    port,
    "agent",
    { message: "Do it", name: "Email" },
    { headers: { "Idempotency-Key": idempotencyKey, ...headers } },
  );
  return response;
}

export function agentMapping(route: string, overrides: HookMappingConfig = {}): HookMappingConfig {
  return {
    match: { path: route },
    action: "agent",
    messageTemplate: "Mapped: {{payload.subject}}",
    ...overrides,
  };
}

export async function writeHookTransformModule(moduleName: string, source: string): Promise<void> {
  const configPath = requireNonEmptyString(
    process.env.OPENCLAW_CONFIG_PATH,
    "OPENCLAW_CONFIG_PATH",
  );
  const transformsDir = path.join(path.dirname(configPath), "hooks", "transforms");
  await fs.mkdir(transformsDir, { recursive: true });
  await fs.writeFile(path.join(transformsDir, moduleName), source, "utf-8");
}

export function buildAgentPayload(name: string, agentId?: string) {
  return {
    message: "test message",
    name,
    agentId,
    effectiveAgentId: agentId ?? "main",
    idempotencyKey: undefined,
    wakeMode: "now" as const,
    sessionKey: "session-1",
    sourcePath: "/hooks/agent",
    deliver: false,
    channel: "last" as const,
    to: undefined,
    delivery: { mode: "none" as const },
    model: undefined,
    thinking: undefined,
    timeoutSeconds: undefined,
    allowUnsafeExternalContent: undefined,
    externalContentSource: undefined,
  };
}
