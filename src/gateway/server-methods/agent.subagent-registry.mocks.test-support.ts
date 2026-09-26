import { vi } from "vitest";
import type { runSubagentAnnounceFlow } from "../../agents/subagents/announce/subagent-announce.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../../agents/subagents/announce/subagent-announce.requester-settle-wake.js";
import type {
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskAsyncOrThrow,
  persistSubagentRunsToDiskOrThrow,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import type { callGateway } from "../call.js";

const subagentRegistryMocks = vi.hoisted(() => ({
  registryCallGateway: vi.fn<typeof callGateway>().mockResolvedValue({ status: "pending" }),
  registryAnnounce: vi.fn<typeof runSubagentAnnounceFlow>(),
  registryWake: vi.fn<typeof maybeWakeRequesterAfterAllChildrenSettled>(),
  registryPersist: vi.fn<typeof persistSubagentRunsToDisk>(),
  registryPersistAsyncOrThrow: vi.fn<typeof persistSubagentRunsToDiskAsyncOrThrow>(),
  registryPersistOrThrow: vi.fn<typeof persistSubagentRunsToDiskOrThrow>(),
}));

export { subagentRegistryMocks };

vi.mock("../server-recovery-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-recovery-runtime-context.js")>()),
  bindGatewayLifecycleRequest: () => subagentRegistryMocks.registryCallGateway,
}));

vi.mock("../../agents/subagents/registry/subagent-registry-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../agents/subagents/registry/subagent-registry-state.js")
    >();
  return {
    ...actual,
    persistSubagentRunsToDisk: (...args: Parameters<typeof actual.persistSubagentRunsToDisk>) =>
      subagentRegistryMocks.registryPersist.getMockImplementation()
        ? subagentRegistryMocks.registryPersist(...args)
        : actual.persistSubagentRunsToDisk(...args),
    persistSubagentRunsToDiskAsyncOrThrow: (
      ...args: Parameters<typeof actual.persistSubagentRunsToDiskAsyncOrThrow>
    ) =>
      subagentRegistryMocks.registryPersistAsyncOrThrow.getMockImplementation()
        ? subagentRegistryMocks.registryPersistAsyncOrThrow(...args)
        : actual.persistSubagentRunsToDiskAsyncOrThrow(...args),
    persistSubagentRunsToDiskOrThrow: (
      ...args: Parameters<typeof actual.persistSubagentRunsToDiskOrThrow>
    ) =>
      subagentRegistryMocks.registryPersistOrThrow.getMockImplementation()
        ? subagentRegistryMocks.registryPersistOrThrow(...args)
        : actual.persistSubagentRunsToDiskOrThrow(...args),
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
  subagentRegistryMocks.registryPersist.mockReset();
  subagentRegistryMocks.registryPersistAsyncOrThrow.mockReset();
  subagentRegistryMocks.registryPersistOrThrow.mockReset();
}
