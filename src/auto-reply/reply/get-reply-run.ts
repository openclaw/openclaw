import {
  runOutsidePreparedModelRuntimePluginGenerationScope,
  withPreparedModelRuntimePluginGenerationScope,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import {
  runOutsidePluginRuntimeGenerationScope,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import type { ReplyPayload } from "../types.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { executePreparedReplyRun } from "./get-reply-run-execute.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";
import { getPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";

/** Runs a prepared reply turn after session, prompt, queue, and policy state are resolved. */
export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const context = await prepareReplyRunContext(params);
  if (context.kind === "reply") {
    return context.reply;
  }
  const execute = async () => {
    const admission = await prepareReplyRunAdmission(context);
    return admission.kind === "reply" ? admission.reply : executePreparedReplyRun(admission);
  };

  const dispatchRuntime = getPreparedReplyDispatchRuntime();
  if (!dispatchRuntime) {
    return execute();
  }

  const { acquireAgentRunPreparedModelRuntime } =
    await import("../../agents/prepared-model-runtime.js");
  const acquireRuntime = (pluginGeneration?: PreparedModelRuntimePluginGeneration) =>
    acquireAgentRunPreparedModelRuntime(
      {
        config: dispatchRuntime.config,
        agentId: dispatchRuntime.agentId,
        agentDir: dispatchRuntime.agentDir,
        allowGatewaySubagentBinding: true,
        workspaceDir: dispatchRuntime.workspaceDir,
        preserveWorkspaceDirOnRefresh: false,
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
        pluginGeneration,
        abortSignal: params.opts?.abortSignal,
      },
    );
  let preparedRuntime: Awaited<ReturnType<typeof acquireRuntime>>;
  try {
    preparedRuntime = await acquireRuntime(dispatchRuntime.pluginGeneration);
  } catch (error) {
    if (!(error instanceof PreparedModelRuntimePublicationSupersededError)) {
      throw error;
    }
    preparedRuntime = await runOutsidePreparedModelRuntimePluginGenerationScope(() =>
      runOutsidePluginRuntimeGenerationScope(() => acquireRuntime()),
    );
  }
  await using lease = preparedRuntime;
  let leaseActive = true;
  try {
    return await withPreparedModelRuntimePluginGenerationScope(
      lease.pluginGeneration,
      () => withPluginRuntimeGenerationScope(lease.snapshot, execute),
      () => (leaseActive ? lease.snapshot : undefined),
    );
  } finally {
    leaseActive = false;
  }
}
