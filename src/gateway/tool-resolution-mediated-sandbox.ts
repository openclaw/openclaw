import { resolveCoreToolFactoryFamily } from "../agents/core-tool-factory-descriptors.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { logWarn } from "../logger.js";

const BRIDGE_MUTATING_TOOLS = new Set(["write", "edit", "apply_patch"]);

export type MediatedSandboxDecision = {
  wantsTools: boolean;
  includeBaseCodingTools: boolean;
  includeShellTools: boolean;
  /** Sandbox the mediated coding tools must be bound to, when one exists. */
  sandbox: SandboxContext | undefined;
  /** True when no coding tool may be built because no sandbox is available. */
  withholdAll: boolean;
  /** Drops mutating tools when the bound bridge cannot fence its mutations. */
  filterBuilt: (tools: AnyAgentTool[]) => AnyAgentTool[];
};

/**
 * Decide how a sandboxed session's mediated coding tools are bound. A sandboxed
 * session must use its prepared sandbox filesystem (rooted execution's, or the
 * one the CLI runner prepared); otherwise the tools would fall back to host
 * paths, so they are withheld. Bridges that do not declare the mutation fence
 * are never given mutating tools on an ordinary run.
 */
export function decideMediatedSandbox(params: {
  surface: string;
  mediatedToolNames: ReadonlySet<string>;
  sandboxed: boolean;
  params: {
    sessionKey: string;
    rootedExecution?: { sandbox: SandboxContext | null };
    sandboxExecution?: { sandbox: SandboxContext };
  };
}): MediatedSandboxDecision {
  const rootedSandbox = params.params.rootedExecution?.sandbox;
  const preparedSandbox = params.params.sandboxExecution?.sandbox;
  const sessionKey = params.params.sessionKey;
  const families = new Set(Array.from(params.mediatedToolNames, resolveCoreToolFactoryFamily));
  const includeBaseCodingTools = families.has("base-coding");
  const includeShellTools = families.has("shell");
  const wantsTools = params.surface === "loopback" && (includeBaseCodingTools || includeShellTools);
  const sandbox = rootedSandbox ?? preparedSandbox;
  const withholdAll = wantsTools && params.sandboxed && !sandbox;
  if (withholdAll) {
    logWarn(
      `mediated coding tools withheld for sandboxed session ${sessionKey}: no prepared sandbox context is available for this run`,
    );
  }
  const cannotFence =
    !rootedSandbox && sandbox !== undefined && sandbox.fsBridge?.enforcesMutationFence !== true;
  if (wantsTools && cannotFence) {
    logWarn(
      `mediated write tools withheld for sandboxed session ${sessionKey}: the sandbox filesystem bridge does not enforce the mutation fence`,
    );
  }
  return {
    wantsTools,
    includeBaseCodingTools,
    includeShellTools,
    sandbox,
    withholdAll,
    filterBuilt: (tools) =>
      cannotFence ? tools.filter((tool) => !BRIDGE_MUTATING_TOOLS.has(tool.name)) : tools,
  };
}
