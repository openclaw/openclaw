import { vi } from "vitest";
import type { runSubagentAnnounceFlow } from "../../agents/subagents/announce/subagent-announce.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import type { callGateway } from "../call.js";

const subagentRegistryMocks = vi.hoisted(() => ({
  registryCallGateway: vi.fn<typeof callGateway>().mockResolvedValue({ status: "pending" }),
  registryAnnounce: vi.fn<typeof runSubagentAnnounceFlow>(),
  registryWake: vi.fn<typeof maybeWakeRequesterAfterAllChildrenSettled>(),
  registryWrite: vi.fn<() => void>(),
  pendingWakeRoots: new Set<Promise<void>>(),
}));

export { subagentRegistryMocks };

vi.mock("../server-recovery-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-recovery-runtime-context.js")>()),
  bindGatewayLifecycleRequest: () => subagentRegistryMocks.registryCallGateway,
}));

vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      ...[context, operation, options]: Parameters<typeof actual.runOpenClawStateWorkerOperation>
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute(command) {
              if (command.type === "subagents.persistChanges") {
                subagentRegistryMocks.registryWrite();
              }
              return scope.execute(command);
            },
          }),
        options,
      ),
  };
});

vi.mock("../../agents/subagents/announce/subagent-announce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agents/subagents/announce/subagent-announce.js")>();
  return {
    ...actual,
    runSubagentAnnounceFlow: (...args: Parameters<typeof actual.runSubagentAnnounceFlow>) =>
      subagentRegistryMocks.registryAnnounce.getMockImplementation()
        ? subagentRegistryMocks.registryAnnounce(...args)
        : actual.runSubagentAnnounceFlow(...args),
  };
});

vi.mock(
  "../../agents/subagents/announce/subagent-announce.requester-settle-wake.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../agents/subagents/announce/subagent-announce.requester-settle-wake.js")
      >();
    const { captureGatewayRootWorkReleaseObserver } =
      await import("../../process/gateway-work-admission.js");
    return {
      ...actual,
      maybeWakeRequesterAfterAllChildrenSettled: (
        ...args: Parameters<typeof actual.maybeWakeRequesterAfterAllChildrenSettled>
      ) => {
        // Cleanup publication precedes this detached wake's worker reads and final release.
        const observeRelease = captureGatewayRootWorkReleaseObserver();
        if (observeRelease) {
          const released = new Promise<void>((resolve) => {
            observeRelease(() => resolve());
          });
          subagentRegistryMocks.pendingWakeRoots.add(released);
          void released.then(() => subagentRegistryMocks.pendingWakeRoots.delete(released));
        }
        return subagentRegistryMocks.registryWake.getMockImplementation()
          ? subagentRegistryMocks.registryWake(...args)
          : actual.maybeWakeRequesterAfterAllChildrenSettled(...args);
      },
    };
  },
);

// Handler fixtures own no browser sessions or standalone plugin runtime.
vi.mock("../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));
vi.mock("../../agents/runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
  return { loadAgentRuntimePluginRegistryHandle: createEmptyPluginRegistry };
});

export async function settleAgentSubagentWakeRoots(): Promise<void> {
  while (subagentRegistryMocks.pendingWakeRoots.size > 0) {
    await Promise.all(subagentRegistryMocks.pendingWakeRoots);
  }
}

export function resetSubagentRegistryMocks() {
  subagentRegistryMocks.registryCallGateway.mockReset().mockResolvedValue({ status: "pending" });
  subagentRegistryMocks.registryAnnounce.mockReset();
  subagentRegistryMocks.registryWake.mockReset();
  subagentRegistryMocks.registryWrite.mockReset();
}
