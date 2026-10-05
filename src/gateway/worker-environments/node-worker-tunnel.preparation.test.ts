import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { imageReserveProject } from "./image-reserve.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  BUILD,
  environment,
  startRequest,
  transport,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { createWorkerProjectPreparationIdentity } from "./preparation-identity.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

describe("node workspace preparation projection", () => {
  it.each(["image", "repository"] as const)(
    "preserves the node registration boundary for a %s reserve",
    async (kind) => {
      const root = tempDirs.make("node-worker-preparation-projection-");
      const record = environment();
      const project =
        kind === "image"
          ? imageReserveProject("gateway-test")
          : { key: "b".repeat(64), root: "/prepared/source", baseCommit: "c".repeat(40) };
      const preparation = createWorkerProjectPreparationIdentity({
        namespace: "gateway-test",
        providerId: record.providerId,
        profileId: record.profileId,
        profileSnapshot: record.profileSnapshot,
        project,
        target: { machineClass: "small", platform: "linux", arch: "x64" },
        artifacts: {
          nodeBootstrapSha256: "d".repeat(64),
          enabledPluginIds: [],
          workerBundleHash: BUILD.bundleHash,
          workerArchiveSha256: "e".repeat(64),
          openclawVersion: BUILD.openclawVersion,
          protocolFeatures: BUILD.protocolFeatures,
        },
      });
      record.profileSnapshot = { ...record.profileSnapshot, project: { ...project, preparation } };
      const runtime = new NodeWorkerWorkspaceRuntime({
        root: path.join(root, "node"),
        env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") },
        ephemeral: true,
      });
      const nodeTransport = transport();
      const invoke = vi
        .spyOn(nodeTransport, "invoke")
        .mockImplementation(async ({ command, params, isDispatchAuthorized, onDispatchReady }) => {
          expect(isDispatchAuthorized()).toBe(true);
          onDispatchReady?.("preparation-command");
          if (command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
            return { ok: true, payloadJSON: "null" };
          }
          const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(params));
          try {
            return { ok: true, payloadJSON: JSON.stringify(await runtime.exec(input)) };
          } catch (error) {
            return { ok: false, error: { code: "INVALID_REQUEST", message: String(error) } };
          }
        });
      const transfer = workspaceTransfer();
      transfer.prepareRepository = vi.fn(async () => {});
      const manager = createNodeWorkerTunnelManager({
        gatewayDeviceId: "gateway-device-1",
        getEnvironment: () => record,
        listEnvironments: () => [record],
        getTransport: () => nodeTransport,
        launchNodeWorker: vi.fn(),
        validateWorkerTurn: () => true,
        workspaceTransfer: transfer,
      });
      manager.bindWorkspaceBindingResolver(async () => ({
        source: {
          kind: "repository",
          baseCommit: "c".repeat(40),
          baseManifestRef: `sha256:${"f".repeat(64)}`,
        },
        manifestRef: `sha256:${"f".repeat(64)}`,
        remoteWorkspaceDir: "/worker/repository",
        sessionKey: "agent:main:session-1",
      }));
      const handle = await manager.start(startRequest());
      const operation = handle.runWorkspaceCommand({
        argv: [NODE_WORKSPACE_DRAIN_COMMAND],
        transportRetry: "never",
      });
      if (kind === "image") {
        await expect(operation).resolves.toMatchObject({ code: 0, stdout: "drained\n" });
        expect(invoke.mock.calls.at(-1)![0].params).not.toHaveProperty("preparationKey");
      } else {
        await expect(operation).rejects.toThrow(
          "prepared workspace registration is missing or changed",
        );
        expect(invoke.mock.calls.at(-1)![0].params).toMatchObject({
          preparationKey: preparation.key,
          sessionKey: "agent:main:session-1",
        });
      }
      await handle.stop();
    },
  );
});
