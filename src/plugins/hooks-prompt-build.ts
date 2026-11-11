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
    registration: PluginHookRegistration<"before_prompt_build">,
  ) => PluginHookBeforePromptBuildResult;
  includeRegistration: (registration: PluginHookRegistration<"before_prompt_build">) => boolean;
  onHandlerDropped: (params: { pluginId: string }) => void;
  assertHandlerBoundaryActive?: () => void;
};

export type PromptBuildHookDispatchDeps = {
  /**
   * Merges two before_prompt_build results, owned by the hook runner. Takes the
   * contributing plugin and the dispatch context because the runner bounds
   * plugin-authored system context per plugin and per turn.
   */
  mergeResults: (
    acc: PluginHookBeforePromptBuildResult | undefined,
    next: PluginHookBeforePromptBuildResult,
    pluginId: string,
    ctx: PluginHookAgentContext,
  ) => PluginHookBeforePromptBuildResult;
  /** Merges the authorized phase's context-only results, owned by the hook runner. */
  mergeAuthorizedResults: (
    acc: PluginHookBeforePromptBuildResult | undefined,
    next: PluginHookBeforePromptBuildResult,
  ) => PluginHookBeforePromptBuildResult;
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
 * The marker is host-authored, not a plugin contribution, but it travels through
 * the same merge so it lands in the same append-context slot. The merge only
 * reads a plugin id to bound plugin-authored system context, which the marker
 * never carries.
 */
const DROP_MARKER_PLUGIN_ID = "openclaw";

/**
 * Owns the two before_prompt_build dispatch phases and the loss reporting they
 * share: the ordinary phase, and the authorized phase that runs after the host
 * has finalized the turn's tool surface. Both answer the same question — which
 * plugin contributions reached this prompt, and which are missing from it.
 */
export function createPromptBuildHookDispatch(
  deps: PromptBuildHookDispatchDeps,
): PromptBuildHookDispatch {
  const { mergeResults, mergeAuthorizedResults, dispatch } = deps;

  /**
   * Run before_prompt_build hook.
   * Allows plugins to inject context and system prompt before prompt submission.
   */
  async function runBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const drops: PromptBuildDrop[] = [];
    const result = await dispatch(event, ctx, {
      mergeResults: (acc, next, hook) => mergeResults(acc, next, hook.pluginId, ctx),
      onHandlerDropped: ({ pluginId }) => {
        // Reason code only: the error itself is model-visible nowhere.
        // handleHookError already logged it for operators.
        drops.push({ pluginId, reason: "handler-failed" });
      },
      includeRegistration: (registration) => registration.requiresToolAuthority !== true,
    });
    const dropMarker = buildPromptBuildDropResult(drops);
    if (!dropMarker) {
      return result;
    }
    return mergeResults(result, dropMarker, DROP_MARKER_PLUGIN_ID, ctx);
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
    const activeToolNameSet = new Set(
      params.activeToolNames.map(normalizeToolPolicyName).filter(Boolean),
    );
    const activeToolNames = Object.freeze([...activeToolNameSet].toSorted());
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
      list(): readonly string[] {
        assertActive();
        return activeToolNames;
      },
      assertActive,
    });
    const drops: PromptBuildDrop[] = [];
    try {
      const result = await dispatch(
        event,
        { ...ctx, toolAuthority: authority },
        {
          mergeResults: mergeAuthorizedResults,
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
      return dropMarker ? mergeAuthorizedResults(projectedResult, dropMarker) : projectedResult;
    } finally {
      token.active = false;
    }
  }

  return { runBeforePromptBuild, runAuthorizedPromptBuild };
}
