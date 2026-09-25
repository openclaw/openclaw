import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
  PluginHookToolAuthority,
} from "./hook-types.js";
import { buildPromptBuildDropResult, type PromptBuildDrop } from "./prompt-build-drop.js";

/**
 * Subset of the runner's modifying-hook policy these dispatchers supply. Declared
 * structurally so this module never has to import back from the hook runner.
 */
type PromptBuildDispatchPolicy = {
  mergeResults: (
    acc: PluginHookBeforePromptBuildResult | undefined,
    next: PluginHookBeforePromptBuildResult,
  ) => PluginHookBeforePromptBuildResult;
  includeRegistration: (registration: PluginHookRegistration<"before_prompt_build">) => boolean;
  onHandlerDropped: (params: { pluginId: string }) => void;
  assertHandlerBoundaryActive?: () => void;
};

export type PromptBuildHookDispatchDeps = {
  logger?: { warn: (message: string) => void };
  /** Merges two before_prompt_build results, owned by the hook runner. */
  mergeResults: PromptBuildDispatchPolicy["mergeResults"];
  /** Every registered before_prompt_build hook, in the runner's priority order. */
  listRegistrations: () => readonly PluginHookRegistration<"before_prompt_build">[];
  /** Runs the runner's modifying-hook chain for before_prompt_build. */
  dispatch: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
    policy: PromptBuildDispatchPolicy,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
};

export type PromptBuildHookDispatch = {
  runBeforePromptBuild: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runAuthorizedPromptBuild: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
    params: {
      toolAuthorityFingerprint: string;
      activeToolNames: readonly string[];
      assertHostActive: () => void;
    },
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
};

/**
 * Owns the two before_prompt_build dispatch phases and the loss reporting they
 * share: the ordinary phase, and the authorized phase that runs after the host
 * has finalized the turn's tool surface. Both answer the same question — which
 * plugin contributions reached this prompt, and which are missing from it.
 */
export function createPromptBuildHookDispatch(
  deps: PromptBuildHookDispatchDeps,
): PromptBuildHookDispatch {
  const { logger, mergeResults, listRegistrations, dispatch } = deps;
  // Prompt-build hooks may start nested agent runs through any caller. The
  // mutable token lets detached descendants dispatch after the outer run settles.
  const beforePromptBuildDispatch = new AsyncLocalStorage<{ active: boolean }>();

  /**
   * Run before_prompt_build hook.
   * Allows plugins to inject context and system prompt before prompt submission.
   */
  async function runBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    if (beforePromptBuildDispatch.getStore()?.active) {
      // The whole chain is skipped so nested prompt builds cannot recurse. Name
      // the plugins whose contributions this prompt is missing rather than
      // returning a prompt that reads as if they had nothing to add.
      const skippedPluginIds = [
        ...new Set(
          listRegistrations()
            .filter((hook) => hook.requiresToolAuthority !== true)
            .map((hook) => hook.pluginId),
        ),
      ];
      if (skippedPluginIds.length === 0) {
        return undefined;
      }
      logger?.warn(
        `[hooks] before_prompt_build skipped for a nested prompt build; ` +
          `contributions from ${skippedPluginIds.join(", ")} are missing from this turn`,
      );
      return buildPromptBuildDropResult(
        skippedPluginIds.map((pluginId) => ({ pluginId, reason: "nested-prompt-build" as const })),
      );
    }
    const token = { active: true };
    const drops: PromptBuildDrop[] = [];
    const result = await beforePromptBuildDispatch.run(token, async () => {
      try {
        return await dispatch(event, ctx, {
          mergeResults,
          onHandlerDropped: ({ pluginId }) => {
            // Reason code only: the error itself is model-visible nowhere.
            // handleHookError already logged it for operators.
            drops.push({ pluginId, reason: "handler-failed" });
          },
          includeRegistration: (registration) => registration.requiresToolAuthority !== true,
        });
      } finally {
        token.active = false;
      }
    });
    const dropMarker = buildPromptBuildDropResult(drops);
    if (!dropMarker) {
      return result;
    }
    return mergeResults(result, dropMarker);
  }

  /** Runs context enrichment only after the host has finalized the turn's tool surface. */
  async function runAuthorizedPromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
    params: {
      toolAuthorityFingerprint: string;
      activeToolNames: readonly string[];
      assertHostActive: () => void;
    },
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const sourceFingerprint = params.toolAuthorityFingerprint.trim();
    if (!sourceFingerprint) {
      return undefined;
    }
    const activeToolNames = [
      ...new Set(params.activeToolNames.map(normalizeToolPolicyName).filter(Boolean)),
    ].toSorted();
    const activeToolNameSet = new Set(activeToolNames);
    const token = { active: true };
    const assertActive = () => {
      if (!token.active) {
        throw new Error("prompt tool authority is no longer active");
      }
      params.assertHostActive();
    };
    const authority: PluginHookToolAuthority = Object.freeze({
      fingerprint: createHash("sha256")
        .update(sourceFingerprint)
        .update("\0")
        .update(activeToolNames.join("\0"))
        .digest("hex"),
      allows(toolName: string): boolean {
        assertActive();
        return activeToolNameSet.has(normalizeToolPolicyName(toolName));
      },
      assertActive,
    });
    const drops: PromptBuildDrop[] = [];
    try {
      const result = await dispatch(
        event,
        { ...ctx, toolAuthority: authority },
        {
          mergeResults,
          includeRegistration: (registration) => registration.requiresToolAuthority === true,
          assertHandlerBoundaryActive: assertActive,
          onHandlerDropped: ({ pluginId }) => {
            drops.push({ pluginId, reason: "handler-failed" });
          },
        },
      );
      const projectedResult = result
        ? {
            ...(result.prependContext ? { prependContext: result.prependContext } : {}),
            ...(result.appendContext ? { appendContext: result.appendContext } : {}),
          }
        : undefined;
      const dropMarker = buildPromptBuildDropResult(drops);
      return dropMarker ? mergeResults(projectedResult, dropMarker) : projectedResult;
    } finally {
      token.active = false;
    }
  }

  return { runBeforePromptBuild, runAuthorizedPromptBuild };
}
