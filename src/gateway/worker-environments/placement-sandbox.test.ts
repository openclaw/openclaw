import { expect, it, vi } from "vitest";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import { createRemoteExecPlacementSandbox } from "./placement-sandbox.js";
import { activePlacement } from "./placement-suite.test-support.js";
import type { WorkerEnvironmentService } from "./service.js";

const environmentId = "worker:environment-1";
const remoteWorkspaceDir = "/srv/openclaw/workspaces/session-1";

function remoteExecPlacement() {
  return activePlacement("session-1", {
    executionMode: "remote-exec",
    generation: 11,
    environmentId,
    activeOwnerEpoch: 7,
    remoteWorkspaceDir,
  });
}

function attachedEnvironment() {
  return {
    ...createDispatchEnvironmentFixtures().attached,
    environmentId,
    ownerEpoch: 7,
    sshEndpoint: {
      host: "worker.example.test",
      port: 2202,
      fallbackPorts: [22],
      user: "worker",
      hostKey: "ssh-ed25519 AAAA",
      keyRef: { source: "file", provider: "worker-keys", id: "/key" },
    },
  } satisfies NonNullable<ReturnType<WorkerEnvironmentService["get"]>>;
}

function nodeEnvironment() {
  return {
    ...attachedEnvironment(),
    providerId: "device",
    nodeDeviceId: "paired-node-1",
    sharedHost: true,
    sshEndpoint: null,
  };
}

function sandboxFor(
  environments: Parameters<typeof createRemoteExecPlacementSandbox>[0]["environments"],
  placement = remoteExecPlacement(),
) {
  return createRemoteExecPlacementSandbox({
    environments,
    placement,
    workspaceDir: "/local/managed-worktree",
  });
}

it("binds the exact SSH managed worktree and placement generation into the runtime", async () => {
  const placement = remoteExecPlacement();
  const environment = attachedEnvironment();
  const resolveSshIdentity = vi.fn(async () => ({
    kind: "material" as const,
    contents: "private-key-material",
  }));

  const sandbox = await sandboxFor({ get: () => environment, resolveSshIdentity }, placement);

  expect(resolveSshIdentity).toHaveBeenCalledWith(environmentId);
  expect(sandbox).toMatchObject({
    enabled: true,
    placementExecutionMode: "remote-exec",
    backendId: "ssh",
    runtimeId: "remote-exec:worker:environment-1:7:11",
    workspaceDir: "/local/managed-worktree",
    containerWorkdir: remoteWorkspaceDir,
    backend: { workdir: remoteWorkspaceDir, workdirRoots: [remoteWorkspaceDir] },
  });
  for (const key of ["placementEnvironmentId", "placementSessionId", "placementOwnerEpoch"]) {
    expect(sandbox).not.toHaveProperty(key);
  }
});

it.each([
  { platform: "POSIX", nodeWorkspaceDir: remoteWorkspaceDir },
  {
    platform: "Windows",
    nodeWorkspaceDir: String.raw`C:\Users\Node\.openclaw\node-host\workspaces\session-1`,
  },
])(
  "binds an exact $platform paired-node worktree without inventing an SSH backend or filesystem bridge",
  async ({ nodeWorkspaceDir }) => {
    const placement = { ...remoteExecPlacement(), remoteWorkspaceDir: nodeWorkspaceDir };
    const environment = nodeEnvironment();
    const resolveSshIdentity = vi.fn();

    const sandbox = await sandboxFor({ get: () => environment, resolveSshIdentity }, placement);

    expect(sandbox).toMatchObject({
      enabled: true,
      placementExecutionMode: "remote-exec",
      placementNodeId: "paired-node-1",
      placementEnvironmentId: environmentId,
      placementSessionId: "session-1",
      placementOwnerEpoch: 7,
      backendId: "node",
      runtimeId: "remote-exec:worker:environment-1:7:11",
      workspaceDir: "/local/managed-worktree",
      containerWorkdir: nodeWorkspaceDir,
    });
    expect([sandbox.backend, sandbox.fsBridge]).toEqual([undefined, undefined]);
    expect(resolveSshIdentity).not.toHaveBeenCalled();
  },
);

it.each([
  { label: "POSIX root", workspaceDir: "/" },
  { label: "Windows root", workspaceDir: "C:\\" },
  { label: "POSIX traversal", workspaceDir: "/srv/../workspace" },
  { label: "Windows traversal", workspaceDir: String.raw`C:\Users\..\workspace` },
  { label: "Windows drive-relative path", workspaceDir: "C:workspace" },
  { label: "Windows rooted path without a drive", workspaceDir: String.raw`\workspace` },
  { label: "Windows UNC path", workspaceDir: String.raw`\\server\share\workspace` },
  { label: "mixed Windows separators", workspaceDir: String.raw`C:\Users/workspace` },
  { label: "POSIX trailing separator", workspaceDir: "/srv/workspace/" },
  { label: "Windows trailing separator", workspaceDir: "C:\\Users\\workspace\\" },
])("rejects an ambiguous or noncanonical paired-node $label", async ({ workspaceDir }) => {
  const environment = nodeEnvironment();

  await expect(
    sandboxFor(
      { get: () => environment },
      { ...remoteExecPlacement(), remoteWorkspaceDir: workspaceDir },
    ),
  ).rejects.toThrow("invalid managed workspace path");
});

it("rejects Windows workspace paths for the POSIX SSH carrier", async () => {
  const environment = attachedEnvironment();
  const resolveSshIdentity = vi.fn();

  await expect(
    sandboxFor(
      { get: () => environment, resolveSshIdentity },
      { ...remoteExecPlacement(), remoteWorkspaceDir: String.raw`C:\Users\Node\workspace` },
    ),
  ).rejects.toThrow("invalid managed workspace path");
  expect(resolveSshIdentity).not.toHaveBeenCalled();
});

it.each([
  {
    label: "stale owner epoch",
    replacement: { ownerEpoch: 8 },
  },
  {
    label: "different attached session",
    replacement: { attachedSessionIds: ["replacement-session"] },
  },
  {
    label: "different SSH endpoint",
    replacement: {
      sshEndpoint: { ...attachedEnvironment().sshEndpoint, host: "replacement.example.test" },
    },
  },
])("rejects a $label after awaited SSH identity preparation", async ({ replacement }) => {
  const placement = remoteExecPlacement();
  let environment = attachedEnvironment();
  const resolveSshIdentity = vi.fn(async () => {
    environment = { ...environment, ...replacement };
    return { kind: "material" as const, contents: "private-key-material" };
  });

  await expect(
    sandboxFor({ get: () => environment, resolveSshIdentity }, placement),
  ).rejects.toThrow("lost its exact environment");
});

it.each([
  { label: "node identity", replacement: { nodeDeviceId: "replacement-node" } },
  {
    label: "environment identity",
    replacement: { environmentId: "worker:replacement-environment" },
  },
  { label: "owner epoch", replacement: { ownerEpoch: 8 } },
  { label: "session identity", replacement: { attachedSessionIds: ["replacement-session"] } },
])(
  "rejects a paired node's replaced $label before returning its sandbox",
  async ({ replacement }) => {
    const placement = remoteExecPlacement();
    const environment = nodeEnvironment();
    const get = vi
      .fn<WorkerEnvironmentService["get"]>()
      .mockReturnValueOnce(environment)
      .mockReturnValueOnce({ ...environment, ...replacement });

    await expect(sandboxFor({ get }, placement)).rejects.toThrow("lost its exact environment");
  },
);
