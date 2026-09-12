/** Prepares and runs auto-reply agent turns, including prompt context and session policy. */
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { ReplyPayload } from "../types.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { executePreparedReplyRun } from "./get-reply-run-execute.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";
import { attachModelPolicyNotice } from "./model-policy-notice.js";
import { getPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";

async function executePreparedReplyContext(
  context: Exclude<Awaited<ReturnType<typeof prepareReplyRunContext>>, { kind: "reply" }>,
) {
  let admission: Awaited<ReturnType<typeof prepareReplyRunAdmission>>;
  try {
    admission = await prepareReplyRunAdmission(context);
  } catch (error) {
    const { params } = context;
    if (
      !params.modelState.blockedModelOverrideUsesPrimary ||
      !params.modelState.blockedModelOverrideRef
    ) {
      throw error;
    }
    const failure = buildKnownAgentRunFailureReplyPayload({
      err: error,
      sessionCtx: params.sessionCtx,
      resolvedVerboseLevel: params.resolvedVerboseLevel,
      cfg: params.cfg,
    });
    if (!failure) {
      throw error;
    }
    params.typing.cleanup();
    return attachModelPolicyNotice({
      payloads: [failure],
      pinnedModel: params.modelState.blockedModelOverrideRef,
      primaryModel: `${params.provider}/${params.model}`,
      sessionEntry: params.sessionEntry,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  }
  if (admission.kind === "reply") {
    return admission.reply;
  }

  return executePreparedReplyRun(admission);
}

/** Runs a prepared reply turn after session, prompt, queue, and policy state are resolved. */
export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const context = await prepareReplyRunContext(params);
  if (context.kind === "reply") {
    return context.reply;
  }

  const dispatchRuntime = getPreparedReplyDispatchRuntime();
  if (!dispatchRuntime) {
    return executePreparedReplyContext(context);
  }

  const { acquireAgentRunPreparedModelRuntime } =
    await import("../../agents/prepared-model-runtime.js");
  await using lease = await acquireAgentRunPreparedModelRuntime(
    {
      config: dispatchRuntime.config,
      agentId: dispatchRuntime.agentId,
      agentDir: dispatchRuntime.agentDir,
      allowGatewaySubagentBinding: true,
      workspaceDir: context.workspaceDir,
      runtimePluginSelections: [
        {
          provider: params.provider,
          modelId: params.model,
          runtime: context.thinkingRuntime,
        },
      ],
    },
    {
      catalogMode: "static",
      pluginGeneration: dispatchRuntime.pluginGeneration,
      abortSignal: params.opts?.abortSignal,
    },
  );
  let leaseActive = true;
  try {
    return await withPreparedModelRuntimePluginGenerationScope(
      lease.pluginGeneration,
      () =>
        withPluginRuntimeGenerationScope(lease.snapshot, () =>
          executePreparedReplyContext(context),
        ),
      () => (leaseActive ? lease.snapshot : undefined),
    );
  } finally {
    leaseActive = false;
  }
}
