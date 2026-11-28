import { createAuthProbeWork } from "./list.probe.cleanup.js";
import type { buildProbeTargets } from "./list.probe.js";

export type AuthProbeStateOwnership = {
  mode: "exclusive";
};

/** Direct callers run under offline custody or dispatch one batch to the serving owner. */
export async function withAuthProbeStateOwnership<T>(
  ownership: AuthProbeStateOwnership | undefined,
  batch: Pick<
    Parameters<typeof buildProbeTargets>[0],
    "agentId" | "providers" | "modelCandidates" | "options"
  >,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!ownership) {
    return await run();
  }
  const { runWithLocalStateOwner } = await import("../../cli/local-state-owner.js");
  return await runWithLocalStateOwner({
    method: "models.probeBatch",
    params: () =>
      Promise.resolve({
        agentId: batch.agentId,
        providers: batch.providers,
        modelCandidates: batch.modelCandidates,
        options: batch.options,
      }),
    target: "model credentials",
    requireLocalBackendSharedAuth: true,
    runLocal: async ({ signal }) => {
      const work = await createAuthProbeWork(signal);
      try {
        return await work.run(() => run(signal));
      } finally {
        // Ownership outlives a failed batch until its in-flight probes settle.
        await work.settle(async () => {});
        await work.settled;
      }
    },
  });
}
