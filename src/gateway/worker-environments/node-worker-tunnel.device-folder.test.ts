import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { DEVICE_FOLDER_MANIFEST_REF } from "../../worker/device-folder.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { createDeviceWorkerRuntime } from "./device-provider.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  createManager,
  environment,
  startRequest,
  transport,
  tunnelLaunchPlan,
} from "./node-worker-tunnel.test-support.js";
import type { NodeWorkerWorkspaceBinding } from "./node-worker-tunnel.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nodeCommand = (source: string) => ({
  argv: [path.basename(process.execPath), "-e", source],
  transportRetry: "never" as const,
});
type LaunchNodeWorker = ReturnType<typeof createDeviceWorkerRuntime>["launchNodeWorker"];

async function fixture(launchNodeWorker: LaunchNodeWorker = vi.fn()) {
  const root = tempDirs.make("node-device-folder-tunnel-");
  const folder = path.join(root, "user-folder");
  const alias = path.join(root, "folder-alias");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "existing.txt"), "user-owned\n");
  await fs.symlink(folder, alias, process.platform === "win32" ? "junction" : "dir");
  const canonicalFolder = await fs.realpath(folder);
  await fs.mkdir(path.join(root, "private-home"));
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "private-state"),
    env: { ...process.env, HOME: path.join(root, "private-home") },
    ephemeral: true,
    folders: [folder],
  });
  const commands: NodeWorkerWorkspaceExecInput[] = [];
  const nodeTransport = transport();
  const nodes = await nodeTransport.listCurrentNodes();
  nodes[0]!.workerHost.deviceFolders = true;
  nodeTransport.listCurrentNodes = async () => nodes;
  nodeTransport.invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
    if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
      return { ok: true, payloadJSON: "null" };
    }
    expect(request.command).toBe(NODE_WORKER_WORKSPACE_EXEC_COMMAND);
    expect(request.isDispatchAuthorized()).toBe(true);
    const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
    commands.push(input);
    request.onDispatchReady?.("folder-invoke");
    return { ok: true, payloadJSON: JSON.stringify(await runtime.exec(input, request.signal)) };
  });
  const record = environment();
  record.profileSnapshot = { ...record.profileSnapshot, executionMode: "remote-exec" };
  const managers: ReturnType<typeof createNodeWorkerTunnelManager>[] = [];
  const manager = (binding?: NodeWorkerWorkspaceBinding) => {
    const value = createManager(record, {
      getTransport: () => nodeTransport,
      launchNodeWorker,
    });
    if (binding) {
      value.bindWorkspaceBindingResolver(async () => binding);
    }
    managers.push(value);
    return value;
  };
  return {
    runtime,
    folder: canonicalFolder,
    alias,
    commands,
    nodeTransport,
    manager,
    request: { ...startRequest(), executionMode: "remote-exec" as const },
    sync: (folderPath = canonicalFolder, deviceId = "node-1") => ({
      sessionId: "session-1",
      generation: 1,
      source: { kind: "device-folder" as const, deviceId, path: folderPath },
    }),
    async [Symbol.asyncDispose]() {
      for (const value of managers) {
        await value.stop("environment-1");
      }
      await runtime.processes.close();
      await runtime.quiescence.close();
    },
  };
}

describe("device-folder tunnel", () => {
  it("carries the bound session into a hosted turn's folder acquisition", async () => {
    const launchNodeWorker = vi.fn<LaunchNodeWorker>(async ({ input }) => {
      const acquisition = await test.runtime.acquirePreparedWorkspace({
        gatewayNamespace: input.gatewayNamespace,
        environmentId: input.descriptor.admission.environmentId,
        sessionId: input.descriptor.admission.sessionId,
        ownerEpoch: input.descriptor.admission.ownerEpoch,
        workspaceDir: input.descriptor.assignment.workspaceDir,
        sessionKey: input.sessionKey,
      });
      expect(acquisition?.workspaceDir).toBe(test.folder);
      acquisition?.release();
      return {
        launchId: input.launchId,
        planHash: "b".repeat(64),
        environmentId: "environment-1",
        sessionId: "session-1",
        ownerEpoch: 2,
        placementGeneration: 1,
        runId: "run-1",
        state: "completed",
        resultJson: "{}",
      };
    });
    await using test = await fixture(launchNodeWorker);
    const handle = await test.manager().start({ ...test.request, executionMode: "worker-turn" });
    await handle.syncWorkspace({
      ...test.sync(),
      sessionKey: "agent:main:folder-turn",
    });
    await handle.launchTurn({
      plan: tunnelLaunchPlan(test.folder),
      turnClaim: {
        sessionId: "session-1",
        claimId: "claim-1",
        runId: "run-1",
        placementGeneration: 1,
        owner: { kind: "worker", environmentId: "environment-1", ownerEpoch: 2 },
      },
    });
    expect(launchNodeWorker).toHaveBeenCalledOnce();
    expect(await fs.readdir(test.folder)).toEqual(["existing.txt"]);
  });

  it("binds a non-Git folder without transfer and restores node-only execution after restart", async () => {
    await using test = await fixture();
    const handle = await test.manager().start(test.request);
    const synced = await handle.syncWorkspace({
      ...test.sync(),
      sessionKey: "agent:main:device-folder-test",
    });
    expect(synced).toEqual({
      mode: "device-folder",
      remoteWorkspaceDir: test.folder,
      manifestRef: DEVICE_FOLDER_MANIFEST_REF,
    });
    expect(await fs.readdir(test.folder)).toEqual(["existing.txt"]);
    expect(
      await handle.runWorkspaceCommand(
        nodeCommand(
          'require("node:fs").writeFileSync("result.txt", "node-only\\n"); process.stdout.write(process.cwd())',
        ),
      ),
    ).toMatchObject({
      code: 0,
      stdout: test.folder,
    });
    expect(await fs.readFile(path.join(test.folder, "result.txt"), "utf8")).toBe("node-only\n");
    const binding: NodeWorkerWorkspaceBinding = {
      source: { kind: "device-folder", deviceId: "node-1", path: test.folder },
      manifestRef: DEVICE_FOLDER_MANIFEST_REF,
      remoteWorkspaceDir: test.folder,
      sessionKey: "agent:main:device-folder-test",
    };
    await handle.stop();
    const restored = test.manager(binding);
    expect(
      await restored.runSessionCommand(
        {
          environmentId: "environment-1",
          ownerEpoch: 2,
          sessionId: "session-1",
          sessionKey: binding.sessionKey!,
        },
        nodeCommand('process.stdout.write(require("node:fs").readFileSync("result.txt", "utf8"))'),
      ),
    ).toMatchObject({ code: 0, stdout: "node-only\n" });
    await restored.stop("environment-1");
    const commands = test.commands.map((input) => input.argv[0]);
    expect(commands).toContain(NODE_WORKSPACE_DRAIN_COMMAND);
    expect(
      commands.filter((command) => command === NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND),
    ).toHaveLength(2);
    expect(test.commands.every((input) => input.deviceFolder !== undefined)).toBe(true);
    expect(
      test.commands.every((input) => !input.transfer && !input.seed && !input.resetWorkspace),
    ).toBe(true);
    expect((await fs.readdir(test.folder)).toSorted()).toEqual(["existing.txt", "result.txt"]);
  });

  it("rejects a retargeted folder on first dispatch", async () => {
    await using test = await fixture();
    const handle = await test.manager().start(test.request);
    await expect(handle.syncWorkspace(test.sync(test.alias))).rejects.toThrow("target changed");
    expect(await fs.readdir(test.folder)).toEqual(["existing.txt"]);
  });

  it("refuses synchronization, attachment staging, and quiescence of a bound folder", async () => {
    await using test = await fixture();
    const handle = await test.manager().start(test.request);
    const request = test.sync();
    await handle.syncWorkspace(request);
    const calls = test.commands.length;
    await expect(
      handle.reconcileWorkspace({
        remoteWorkspaceDir: test.folder,
        baseManifestRef: DEVICE_FOLDER_MANIFEST_REF,
        source: {
          kind: "repository",
          referenceManifestRef: DEVICE_FOLDER_MANIFEST_REF,
          prepareCheckpoint: vi.fn(),
        },
      }),
    ).rejects.toThrow("cannot be synchronized or reconciled");
    await expect(
      handle.stageAttachments!({
        localPath: test.folder,
        isAuthorized: () => true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Attachment staging is not supported");
    await expect(handle.quiesceWorkspace(test.folder)).rejects.toThrow(
      "do not support workspace quiescence",
    );
    await expect(
      handle.syncWorkspace({ ...request, source: { kind: "local", path: test.folder } }),
    ).rejects.toThrow("cannot be replaced");
    await expect(
      handle.runWorkspaceCommand({
        argv: ["reset"],
        transportRetry: "never",
        seed: { action: "apply", key: "a".repeat(64) },
      }),
    ).rejects.toThrow("cannot receive workspace transfers");
    expect(test.commands).toHaveLength(calls);
    expect(await fs.readdir(test.folder)).toEqual(["existing.txt"]);
  });

  it("requires matching device identity and advertised folder support before dispatch", async () => {
    await using test = await fixture();
    const handle = await test.manager().start(test.request);
    await expect(handle.syncWorkspace(test.sync(test.folder, "another-node"))).rejects.toThrow(
      "does not belong",
    );
    const unsupported = transport();
    test.nodeTransport.listCurrentNodes = () => unsupported.listCurrentNodes();
    await expect(handle.syncWorkspace(test.sync())).rejects.toThrow(
      "Device folder support is unavailable",
    );
    expect(test.commands).toHaveLength(0);
  });
});
