import { vi } from "vitest";
import { WebSocket } from "ws";
import type { NodeRegistry } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export type TestNodeSocket = {
  readyState: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

export function createTestNodeSocket(
  sent: string[] = [],
  readyState: TestNodeSocket["readyState"] = WebSocket.OPEN,
): TestNodeSocket {
  return {
    readyState,
    bufferedAmount: 0,
    send: vi.fn((frame: unknown) => {
      if (typeof frame === "string") {
        sent.push(frame);
      }
    }),
    close: vi.fn(),
  };
}

export function makeClient(
  connId: string,
  nodeId: string,
  sent: string[] = [],
  opts: {
    clientId?: string;
    displayName?: string;
    platform?: string;
    version?: string;
    caps?: string[];
    commands?: string[];
    computerUse?: unknown;
    declaredComputerUse?: unknown;
    permissions?: Record<string, boolean>;
    declaredCaps?: string[];
    declaredCommands?: string[];
    declaredPermissions?: Record<string, boolean>;
    sessionCapsCeiling?: string[];
    sessionCommandsCeiling?: string[];
    socket?: GatewayWsClient["socket"];
    webSocket?: GatewayWsClient["webSocket"];
  } = {},
): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: opts.socket ?? (createTestNodeSocket(sent) as unknown as GatewayWsClient["socket"]),
    webSocket: opts.webSocket,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: opts.clientId ?? "openclaw-macos",
        version: opts.version ?? "1.0.0",
        platform: opts.platform ?? "darwin",
        mode: "node",
        displayName: opts.displayName,
      },
      device: {
        id: nodeId,
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
      caps: opts.caps ?? [],
      commands: opts.commands ?? [],
      computerUse: opts.computerUse,
      declaredComputerUse: opts.declaredComputerUse,
      permissions: opts.permissions,
      declaredCaps: opts.declaredCaps,
      declaredCommands: opts.declaredCommands,
      declaredPermissions: opts.declaredPermissions,
      sessionCapsCeiling: opts.sessionCapsCeiling,
      sessionCommandsCeiling: opts.sessionCommandsCeiling,
    } as unknown as GatewayWsClient["connect"],
  };
}

export function registerNodeSession(
  registry: NodeRegistry,
  client: GatewayWsClient,
  opts: Partial<Parameters<NodeRegistry["register"]>[1]> = {},
) {
  const { pairingIdentity = "identity-a", ...registration } = opts;
  return registry.register(client, { ...registration, pairingIdentity });
}
