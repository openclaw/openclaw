import type { PreparedAgentCommandRuntimeContext } from "../../agents/command/prepare.js";
import { NO_MODEL_CONFIGURED_MESSAGE } from "../../agents/model-selection-config.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "../../agents/prepared-model-runtime-admission-errors.js";
import {
  scopePreparedModelRuntimeLease,
  withPreparedModelRuntimePluginGenerationScope,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveGatewaySessionModelForRun } from "../session-model-for-run.js";

/**
 * Runs a Talk consult in the Gateway's published reply runtime, leased for the session's own
 * model and harness exactly as a Gateway `agent` turn admits it. Hosts without a published
 * runtime (direct embedding, unit fixtures) keep the command owner's own plugin loading.
 */
export async function withTalkConsultPublishedRuntime<T>(
  params: {
    agentId: string;
    sessionKey: string;
    /** The consult's prepared session row; selects the session's own model and harness. */
    sessionEntry: SessionEntry | undefined;
    workspaceDir?: string;
    abortSignal?: AbortSignal;
  },
  run: (runtimeContext?: PreparedAgentCommandRuntimeContext) => Promise<T>,
): Promise<T> {
  let dispatchLease: ReturnType<typeof scopePreparedModelRuntimeLease> | undefined;
  let published: Awaited<ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>>;
  try {
    published = await loadPublishedGatewayReplyDispatchRuntime({
      agentId: params.agentId,
      abortSignal: params.abortSignal,
      onRuntimeLease: (lease) => {
        dispatchLease = scopePreparedModelRuntimeLease(lease);
      },
    });
  } catch (error) {
    // Publication may hand over its lease before failing; never strand it.
    await dispatchLease?.[Symbol.asyncDispose]();
    if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
      throw error;
    }
    // No published owner for this agent: the command owner loads its own plugins.
    return await run(undefined);
  }
  if (!published || !dispatchLease) {
    await dispatchLease?.[Symbol.asyncDispose]();
    return await run(undefined);
  }
  const borrowed = dispatchLease;
  let modelLease: Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>>;
  try {
    const sessionEntry = params.sessionEntry;
    const sessionModel = await resolveGatewaySessionModelForRun({
      cfg: published.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      entry: sessionEntry,
      abortSignal: params.abortSignal,
      manifestPlugins: published.pluginGeneration.pluginMetadataSnapshot,
    });
    if (!sessionModel) {
      throw new Error(NO_MODEL_CONFIGURED_MESSAGE);
    }
    modelLease = await borrowed.run(() =>
      acquireAgentRunPreparedModelRuntime(
        {
          config: published.config,
          agentId: published.agentId,
          agentDir: published.agentDir,
          allowGatewaySubagentBinding: true,
          workspaceDir: params.workspaceDir ?? published.workspaceDir,
          runtimePluginSelections: [
            {
              provider: sessionModel.provider,
              modelId: sessionModel.model,
              runtime: resolveEffectiveAgentRuntime({
                cfg: published.config,
                provider: sessionModel.provider,
                modelId: sessionModel.model,
                agentId: params.agentId,
                sessionKey: params.sessionKey,
                sessionEntry,
              }),
            },
          ],
        },
        {
          catalogMode: "static",
          pluginGeneration: published.pluginGeneration,
          abortSignal: params.abortSignal,
        },
      ),
    );
  } finally {
    await borrowed[Symbol.asyncDispose]();
  }
  const lease = scopePreparedModelRuntimeLease(modelLease);
  try {
    return await lease.run(() =>
      withPreparedModelRuntimePluginGenerationScope(
        lease.pluginGeneration,
        () => run({ config: published.config, pluginGeneration: lease.pluginGeneration }),
        () => lease.snapshot,
      ),
    );
  } finally {
    await lease[Symbol.asyncDispose]();
  }
}
