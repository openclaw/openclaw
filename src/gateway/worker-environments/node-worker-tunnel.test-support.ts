import { execFileSync } from "node:child_process";
import { vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_PROTOCOL_FEATURES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { SpawnResult } from "../../process/exec.js";
import { NODE_WORKSPACE_DRAIN_COMMAND } from "../../worker/node-workspace-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export const BUILD = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.13",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};

export function environment(): WorkerEnvironmentRecord {
  return {
    preparation: null,
    lastActivatedAtMs: null,
    environmentId: "environment-1",
    providerId: "device",
    profileId: "device:node-1",
    profileSnapshot: { settings: { device: "node-1" } },
    provisionOperationId: "provision-1",
    nodeSetupId: null,
    nodeDeviceId: "node-1",
    sharedHost: true,
    desktop: null,
    bootstrapReceipt: { ...BUILD, installKind: "bundle" },
    ownerEpoch: 2,
    teardownTerminalState: null,
    attachedSessionIds: ["session-1"],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    state: "attached",
    leaseId: "device-lease",
    sshEndpoint: null,
  };
}

export function transport(): NodeWorkerSupervisorTransport {
  return {
    async getCurrentNode(nodeId) {
      return (await this.listCurrentNodes()).find((node) => node.nodeId === nodeId);
    },
    hasCurrentRunner: () => true,
    listCurrentNodes: async () => [
      {
        nodeId: "node-1",
        connId: "conn-1",
        pairingIdentity: "pairing-1",
        pairingGeneration: "generation-1",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 2, available: 2 }, environmentSession: 1 },
        commands: ["system.run"],
      },
    ],
    isCurrent: () => true,
    invoke: withWorkspaceDrain(async ({ command }) =>
      command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND
        ? { ok: true, payloadJSON: "null" }
        : { ok: false, error: { code: "UNAVAILABLE" } },
    ),
  };
}

export function withWorkspaceDrain(
  invoke: NodeWorkerSupervisorTransport["invoke"],
): NodeWorkerSupervisorTransport["invoke"] {
  return async (request) => {
    const input = request.params as { argv?: string[] } | undefined;
    return input?.argv?.[0] === NODE_WORKSPACE_DRAIN_COMMAND
      ? {
          ok: true,
          payloadJSON: workspaceCommandPayload("/node/workspace", { stdout: "drained\n" }),
        }
      : await invoke(request);
  };
}

export function startRequest() {
  return {
    executionMode: "worker-turn" as const,
    environmentId: "environment-1",
    ownerEpoch: 2,
    deviceId: "node-1",
    sessionId: "session-1",
    expectedBuild: BUILD,
  };
}

export function workspaceTransfer(): NodeWorkspaceTransferService {
  return {
    close: vi.fn(async () => {}),
    revoke: vi.fn(),
  } as unknown as NodeWorkspaceTransferService;
}

export function workspaceCommandPayload(workspaceDir: string, result: Partial<SpawnResult>) {
  return JSON.stringify({
    workspaceDir,
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...result,
  });
}

export function manifestCaptureOutput(manifestRef: string): string {
  return JSON.stringify({
    version: 1,
    manifestRef,
    memo: [],
    metrics: {
      contentHashCount: 0,
      contentHashDurationMs: 0,
      memoHitCount: 0,
      memoTruncatedCount: 0,
      totalDurationMs: 0,
    },
  });
}

export function seedNodeWorkspaceRepositories(
  localPath: string,
  remoteWorkspaceDir: string,
): string {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  git(["init", "--quiet", localPath]);
  git(["-C", localPath, "add", "."]);
  git([
    "-C",
    localPath,
    "-c",
    "user.name=Memo Test",
    "-c",
    "user.email=memo@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  const baseCommit = git(["-C", localPath, "rev-parse", "HEAD"]);
  git(["clone", "--quiet", localPath, remoteWorkspaceDir]);
  return baseCommit;
}
