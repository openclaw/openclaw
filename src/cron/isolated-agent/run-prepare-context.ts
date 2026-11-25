import { restoreCronOperatorSource } from "../../gateway/cron-operator-source.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { resolveCronRunPreparation, type PreparedCronRunContext } from "./run-prepare.js";
import { withCronSessionPreparation } from "./run-session-state.js";
import type { RunCronAgentTurnResult } from "./run.types.js";

export async function prepareCronRunContext(
  params: Parameters<typeof resolveCronRunPreparation>[0] & {
    runPrepared?: (context: PreparedCronRunContext) => Promise<RunCronAgentTurnResult>;
  },
) {
  const resolved = await resolveCronRunPreparation(params);
  if (!resolved.ok) {
    return resolved;
  }
  await using resources = resolved.resources;
  const prepareSession = () =>
    withCronSessionPreparation(resolved.admission, async (signal) => {
      let operator: Awaited<ReturnType<typeof restoreCronOperatorSource>>;
      using _ = { [Symbol.dispose]: () => operator?.release() };
      const prepared = await resolved.prepare(signal, async (wait) => {
        if (wait) {
          operator?.release();
          operator = undefined;
          await wait();
        }
        operator = await restoreCronOperatorSource({
          job: params.input.job,
          target: resolved.admission,
          signal,
          deliveryAttemptFence: params.input.deliveryAttemptFence,
        });
        return operator?.authority;
      });
      const runPrepared = params.runPrepared;
      if (!prepared.ok) {
        return prepared;
      }
      if (!runPrepared) {
        return { ...prepared, completed: undefined };
      }
      // Execution retains its selected runtime; close preparation's borrowed dispatch scope.
      await resources.disposeAsync();
      // Materialize the prepared incarnation for inference and its own finalization effects.
      return await withSessionTurn(
        {
          sessionKey: prepared.context.runSessionKey,
          sessionId: prepared.context.runSessionId,
          agentId: resolved.admission.agentId,
          storePath: prepared.context.cronSession.storePath,
          abortSignal: signal,
        },
        async () => ({ ...prepared, completed: await runPrepared(prepared.context) }),
      );
    });
  return resolved.runtimeLease
    ? await resolved.runtimeLease.run(prepareSession)
    : await prepareSession();
}
