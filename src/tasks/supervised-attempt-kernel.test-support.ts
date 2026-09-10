import { vi } from "vitest";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
export const candidateKernel = { member: vi.fn(), closed: vi.fn() };
// Only kernel facts are simulated. Storage, source/lease authority, immutable
// copies, disposition, and candidate consumption use production APIs. No real
// namespace or process-extinction proof is claimed by these unit fixtures.
export async function mockAttemptKernel(
  importOriginal: () => Promise<typeof import("./supervised-process-resources.js")>,
) {
  return {
    ...(await importOriginal()),
    supervisedProcessScopeName: (id: string) => `openclaw-task-${id}.scope`,
    readSupervisedProcessHostIdentity: () => ({
      hostId: "a".repeat(64),
      bootId: "e1b0a23e-26d8-4ee6-ac6c-e67a10cc5c99",
    }),
    validateSupervisedProcessResourceLimits: () => {},
    inspectSupervisedProcessScope: async ({
      resourceId,
      limits,
    }: {
      resourceId: string;
      limits: { memoryBytes: number; tasks: number };
    }) => ({
      resourceId,
      scopeName: `openclaw-task-${resourceId}.scope`,
      invocationId: "b".repeat(32),
      controlGroup: `/fixture/${resourceId}`,
      hostId: "a".repeat(64),
      bootId: "e1b0a23e-26d8-4ee6-ac6c-e67a10cc5c99",
      custodian: requireNodeWorkerProcessIdentity(process.pid),
      cgroupDevice: "25",
      cgroupInode: "100",
      limits,
    }),
    isSupervisedProcessScopeClosed: candidateKernel.closed,
    isSealedSupervisedProcessScopeAbsent: async () => true,
    assertSupervisedProcessScopeMember: candidateKernel.member,
  };
}
