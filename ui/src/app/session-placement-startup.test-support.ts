import { expect, onTestFinished, vi, type Mock } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
  type SessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import { createChatSubmissions } from "./chat-submissions.ts";
import type { ApplicationGateway } from "./gateway.ts";
import createApplicationPlacementStartupRuntime from "./session-placement-startup.runtime.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";

export function createStartupPlacement(
  state: string,
  generation: number,
  updatedAtMs = generation,
) {
  return {
    state,
    generation,
    createdAtMs: 1,
    updatedAtMs,
    stateChangedAtMs: updatedAtMs,
    ...(state === "active"
      ? {
          environmentId: "environment-1",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "manifest",
          remoteWorkspaceDir: "/workspace",
        }
      : {}),
  };
}

export function createPlacementStartupHarness(
  request: ReturnType<typeof vi.fn>,
  options: {
    loadRuntime?: Parameters<typeof createApplicationPlacementStartup>[1];
    recoveryBeforeStartup?: boolean;
  } = {},
) {
  const sessionKey = "agent:cloud:startup";
  const client = { request, recoveryScope: "principal-a", recoveryScopeReady: true };
  const gateway = {
    connectionRevision: 0,
    connection: { gatewayUrl: "ws://gateway.example" },
    snapshot: { phase: "connected", client, hello: {} },
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationGateway;
  const row = {
    key: sessionKey,
    placement: createStartupPlacement("requested", 1),
  } as GatewaySessionRow;
  const state = { result: { sessions: [row] } as SessionsListResult };
  const sessions = {
    state,
    describe: ((params, describeOptions) => {
      if (!describeOptions?.client) {
        throw new Error("placement describe requires its captured client");
      }
      return describeOptions.client.request("sessions.describe", params);
    }) satisfies SessionCapability["describe"],
    invalidate: vi.fn(),
    refresh: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as SessionCapability;
  const recovery: Parameters<typeof writeSessionPlacementRecovery>[0] = {
    sessionKey,
    sessionId: "physical-startup-session",
    messageId: "message-stable",
    message: "fix the cloud task",
    target: { kind: "profile", profileId: "aws" },
    agentId: "cloud",
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal-a",
    phase: "dispatching",
  };
  if (options.recoveryBeforeStartup) {
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  }
  const chatSubmissions = createChatSubmissions();
  const dependencies = { gateway, sessions, chatSubmissions };
  const startup = createApplicationPlacementStartup(
    dependencies,
    options.loadRuntime ?? (async () => ({ default: createApplicationPlacementStartupRuntime })),
  );
  onTestFinished(() => startup.dispose());
  if (!options.recoveryBeforeStartup) {
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  }
  return {
    startup,
    key: sessionKey,
    input: { recovery, persistRecovery: true, mode: "dispatch" as const, createdAt: 1_000 },
    client,
    ...dependencies,
    state,
    dependencies,
  };
}

export function blockStorageWrites() {
  const storage = sessionStorage;
  vi.stubGlobal("sessionStorage", {
    get length() {
      return storage.length;
    },
    key: storage.key.bind(storage),
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    setItem: () => {
      throw new Error("quota");
    },
  });
  return storage;
}

export async function flushStartupMicrotasks() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

export function readStartupRecovery(recovery: SessionPlacementRecovery) {
  return readSessionPlacementRecovery(
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  );
}

export function startupCalls<T extends (...args: never[]) => unknown>(
  request: Mock<T>,
  method: string,
) {
  return request.mock.calls.filter(([name]) => name === method);
}

export function startupMethods<T extends (...args: never[]) => unknown>(request: Mock<T>) {
  return request.mock.calls.map(([method]) => method);
}

type StartupRequestParams = {
  idempotencyKey?: string;
  archived?: boolean;
  [key: string]: unknown;
};

export function startupRequest(
  handlers: Record<string, (params: StartupRequestParams) => unknown>,
) {
  return vi.fn((method: string, params: StartupRequestParams = {}) => {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) {
      throw new Error(`Unexpected ${method}`);
    }
    return handler(params);
  });
}
