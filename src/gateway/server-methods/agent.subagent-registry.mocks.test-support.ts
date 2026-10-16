import { vi } from "vitest";
import type { runSubagentAnnounceFlow } from "../../agents/subagents/announce/subagent-announce.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import type { callGateway } from "../call.js";

const subagentRegistryMocks = vi.hoisted(() => ({
  registryCallGateway: vi.fn<typeof callGateway>().mockResolvedValue({ status: "pending" }),
  registryAnnounce: vi.fn<typeof runSubagentAnnounceFlow>(),
  registryWake: vi.fn<typeof maybeWakeRequesterAfterAllChildrenSettled>(),
  registryWrite: vi.fn<() => void>(),
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
    return {
      ...actual,
      maybeWakeRequesterAfterAllChildrenSettled: (
        ...args: Parameters<typeof actual.maybeWakeRequesterAfterAllChildrenSettled>
      ) =>
        subagentRegistryMocks.registryWake.getMockImplementation()
          ? subagentRegistryMocks.registryWake(...args)
          : actual.maybeWakeRequesterAfterAllChildrenSettled(...args),
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

export function resetSubagentRegistryMocks() {
  subagentRegistryMocks.registryCallGateway.mockReset().mockResolvedValue({ status: "pending" });
  subagentRegistryMocks.registryAnnounce.mockReset();
  subagentRegistryMocks.registryWake.mockReset();
  subagentRegistryMocks.registryWrite.mockReset();
}
