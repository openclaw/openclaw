import {
  runOutsidePreparedModelRuntimePluginGenerationScope,
  scopePreparedModelRuntimeLease,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { createRuntimeConfigReader } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRetentionOwner } from "../../plugins/plugin-retention-diagnostics.js";
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
import {
  prepareReplySourceInput,
  retireUnadoptedReplySource,
  retargetReplySourceForExecution,
} from "./reply-source-binding.js";

/** Runs a prepared reply turn after session, prompt, queue, and policy state are resolved. */
export async function runPreparedReply(
  inputParams: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  return withPluginRetentionOwner(
    { agentId: inputParams.agentId, sessionKey: inputParams.sessionKey },
    () => runPreparedReplyWithOwner(inputParams),
  );
}

// Attribute acquisitions before preparation; the admitted runner adds its run ID.
async function runPreparedReplyWithOwner(
  inputParams: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const source = await prepareReplySourceInput(inputParams.ctx, inputParams.cfg, inputParams.opts);
  const params = { ...inputParams, opts: source.options };
  const readAdmissionConfig = createRuntimeConfigReader(params.cfg);
  try {
    retargetReplySourceForExecution({
      ctx: params.ctx,
      options: params.opts,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath:
        params.storePath ??
        resolveSessionStorePathCore(params.cfg.session?.store, { agentId: params.agentId }),
      agentId: params.agentId,
    });
    const context = await prepareReplyRunContext(params);
    if (context.kind === "reply") {
      return context.reply;
    }

    const dispatchRuntime = getPreparedReplyDispatchRuntime();
    if (!dispatchRuntime) {
      return await executePreparedReplyContext(context, readAdmissionConfig);
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
          // Inventory is agent-owned; context.workspaceDir remains the execution boundary.
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
      // Dispatch captured a selection, not execution. Re-admit before any model/tool work starts.
      preparedRuntime = await runOutsidePreparedModelRuntimePluginGenerationScope(() =>
        runOutsidePluginRuntimeGenerationScope(() => acquireRuntime()),
      );
    }
    await using lease = scopePreparedModelRuntimeLease(preparedRuntime);
    return await lease.run(() =>
      withPluginRuntimeGenerationScope(lease.snapshot, () =>
        executePreparedReplyContext(context, readAdmissionConfig),
      ),
    );
  } finally {
    if (source.created) {
      retireUnadoptedReplySource(source.input);
    }
  }
}

async function executePreparedReplyContext(
  context: Extract<Awaited<ReturnType<typeof prepareReplyRunContext>>, { kind: "ready" }>,
  readAdmissionConfig: () => OpenClawConfig,
) {
  const admission = await prepareReplyRunAdmission(context);
  return admission.kind === "reply"
    ? admission.reply
    : executePreparedReplyRun(admission, readAdmissionConfig);
}
