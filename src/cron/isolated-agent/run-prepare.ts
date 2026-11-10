/** Runs preparation and its admitted turn within the same session lifecycle. */
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { resolveCronRunPreparation, type CronRunPreparationParams } from "./run-prepare-context.js";
import { withCronSessionPreparation } from "./run-session-state.js";

type CronRunPreparation = Extract<
  Awaited<ReturnType<typeof resolveCronRunPreparation>>,
  { ok: true }
>;

export type PreparedCronRunContext = Extract<
  Awaited<ReturnType<CronRunPreparation["prepare"]>>,
  { ok: true }
>["context"];

export async function prepareCronRunContext(
  params: CronRunPreparationParams & {
    runPrepared?: (
      context: PreparedCronRunContext,
    ) => Promise<import("./run.types.js").RunCronAgentTurnResult>;
  },
) {
  const resolved = await resolveCronRunPreparation(params);
  if (!resolved.ok) {
    return resolved;
  }
  await using _ = resolved.resources;
  const prepareSession = () =>
    withCronSessionPreparation(resolved.admission, async (signal) => {
      const prepared = await resolved.prepare(signal);
      const runPrepared = params.runPrepared;
      if (!prepared.ok) {
        return prepared;
      }
      if (!runPrepared) {
        return { ...prepared, completed: undefined };
      }
      // Execution retains its selected runtime; close preparation's borrowed dispatch scope.
      await resolved.resources.disposeAsync();
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
