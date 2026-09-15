// Shared fixtures for the fleet service suites (service.runtime.test.ts and
// service-upgrade.runtime.test.ts), which exercise the same createFleetService
// seam from opposite ends: cell lifecycle and upgrade/restore.
import path from "node:path";
import { vi } from "vitest";
import { cellOwnerId } from "./cell-profile.js";
import type { FleetContainerInspectResult, FleetContainerRuntime } from "./containers.runtime.js";
import { createFleetService as createFleetServiceRuntime } from "./service.runtime.js";

type FleetServiceOptions = NonNullable<Parameters<typeof createFleetServiceRuntime>[0]>;

export const TEST_ATTEMPT_ID = "22222222222222222222222222222222";
export const NEXT_ATTEMPT_ID = "44444444444444444444444444444444";

// The cell owner id is derived from the suite's temp state dir, so each suite
// publishes its per-test root here before building labels. Vitest isolates
// module state per test file, so the two suites never share this value.
let suiteRoot = "";

export function setFleetSuiteRoot(root: string): void {
  suiteRoot = root;
}

export function createFleetService(options: FleetServiceOptions = {}) {
  return createFleetServiceRuntime({ probePort: async () => true, ...options });
}

export function fleetLabels(tenant = "acme", attemptId = TEST_ATTEMPT_ID): Record<string, string> {
  return {
    "openclaw.fleet.tenant": tenant,
    "openclaw.fleet.owner": cellOwnerId(path.join(suiteRoot, "fleet", "cells", tenant)),
    "openclaw.fleet.attempt": attemptId,
    "openclaw.fleet.env-keys": "FEATURE",
  };
}

export function runningInspection(
  overrides: Partial<Extract<FleetContainerInspectResult, { kind: "ok" }>> = {},
): Extract<FleetContainerInspectResult, { kind: "ok" }> {
  return {
    kind: "ok",
    containerId: "container-id",
    state: "running",
    running: true,
    labels: fleetLabels(),
    environment: {
      HOME: "/home/node",
      OPENCLAW_GATEWAY_TOKEN: "old-token",
      FEATURE: "enabled",
      NODE_VERSION: "old-image-default",
    },
    imageId: "sha256:old-image-id",
    memory: "2147483648",
    cpus: "2",
    pidsLimit: 512,
    storageOpt: {},
    capDrop: ["ALL"],
    effectiveCaps: undefined,
    securityOpt: ["no-new-privileges"],
    init: true,
    restartPolicy: "unless-stopped",
    portBindings: [{ containerPort: "18789/tcp", hostIp: "127.0.0.1", hostPort: "19100" }],
    ...overrides,
  };
}

export function createContainerMock(
  initialInspection: FleetContainerInspectResult = {
    kind: "missing",
    state: "missing",
  },
) {
  const assertLocal = vi.fn<FleetContainerRuntime["assertLocal"]>(async () => undefined);
  const inspections = new Map<string, FleetContainerInspectResult>();
  const removedContainers = new Set<string>();
  const inspect = vi.fn<FleetContainerRuntime["inspect"]>(async (_runtime, name) =>
    removedContainers.has(name)
      ? { kind: "missing", state: "missing" }
      : (inspections.get(name) ?? initialInspection),
  );
  const networks = new Map<
    string,
    Extract<Awaited<ReturnType<FleetContainerRuntime["inspectNetwork"]>>, { kind: "ok" }>
  >();
  const inspectNetwork = vi.fn<FleetContainerRuntime["inspectNetwork"]>(
    async (_runtime, name) => networks.get(name) ?? { kind: "missing" },
  );
  const isDockerRootless = vi.fn<FleetContainerRuntime["isDockerRootless"]>(async () => false);
  const run = vi.fn<FleetContainerRuntime["run"]>(async (profile, start) => {
    removedContainers.delete(profile.containerName);
    inspections.set(
      profile.containerName,
      runningInspection({
        state: start ? "running" : "created",
        running: start,
        labels: {
          ...fleetLabels(profile.tenantId, profile.attemptId),
          "openclaw.fleet.env-keys": profile.userEnvironmentKeys.toSorted().join(","),
        },
        environment: { ...profile.environment },
        containerId: `container-${profile.attemptId}`,
        imageId: `sha256:${profile.attemptId}`,
        memory: profile.memory,
        cpus: profile.cpus,
        pidsLimit: profile.pidsLimit,
      }),
    );
  });
  const pull = vi.fn<FleetContainerRuntime["pull"]>(async () => undefined);
  const createNetwork = vi.fn<FleetContainerRuntime["createNetwork"]>(
    async (_runtime, name, labels, options) => {
      networks.set(name, {
        kind: "ok",
        labels: { ...labels },
        attachedContainers: [],
        internal: options.internal,
      });
    },
  );
  const removeNetwork = vi.fn<FleetContainerRuntime["removeNetwork"]>(async (_runtime, name) => {
    networks.delete(name);
  });
  const start = vi.fn<FleetContainerRuntime["start"]>(async (_runtime, name) => {
    const current = await inspect("docker", name);
    if (current.kind === "ok") {
      inspections.set(name, { ...current, state: "running", running: true });
    }
  });
  const stop = vi.fn<FleetContainerRuntime["stop"]>(async () => undefined);
  const restart = vi.fn<FleetContainerRuntime["restart"]>(async () => undefined);
  const logs = vi.fn<FleetContainerRuntime["logs"]>(async () => undefined);
  const remove = vi.fn<FleetContainerRuntime["remove"]>(async (_runtime, name) => {
    inspections.delete(name);
    removedContainers.add(name);
    inspect.mockResolvedValue({ kind: "missing", state: "missing" });
  });
  return {
    runtime: {
      assertLocal,
      inspect,
      inspectNetwork,
      isDockerRootless,
      run,
      pull,
      createNetwork,
      removeNetwork,
      start,
      stop,
      restart,
      logs,
      remove,
    },
    assertLocal,
    inspect,
    inspectNetwork,
    isDockerRootless,
    run,
    pull,
    createNetwork,
    removeNetwork,
    start,
    stop,
    restart,
    logs,
    remove,
  };
}
