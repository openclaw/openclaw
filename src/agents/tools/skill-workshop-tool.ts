/**
 * Skill Workshop built-in tool.
 *
 * Exposes proposal create/update/review/apply actions while the workshop service owns persistence.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { resolveSkillWorkshopConfig } from "../../skills/workshop/config.js";
import { resolveSkillWorkshopProjectionBudgets } from "../../skills/workshop/model-context-budget.js";
import type {
  SkillProposalOrigin,
  SkillWorkshopProposalMutationBudget,
  SkillWorkshopProposalRevisionConstraint,
} from "../../skills/workshop/types.js";
import { captureAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import {
  asToolParamsRecord,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import { buildSkillWorkshopToolDescription } from "./skill-workshop-tool-description.js";
import { createLibrarySkillWorkshopTool } from "./skill-workshop-tool-library.js";
import {
  buildSkillWorkshopToolSchema,
  resolveProposalOnlyActions,
} from "./skill-workshop-tool-schema.js";

const loadExecution = createLazyRuntimeModule(() => import("./skill-workshop-tool.execution.js"));

function bindProposalRevisionConstraint(
  params: Record<string, unknown>,
  action: string,
  constraint: SkillWorkshopProposalRevisionConstraint | undefined,
): Record<string, unknown> {
  if (!constraint) {
    return params;
  }
  if (!constraint.proposalId.trim()) {
    throw new ToolInputError("operator-reviewed proposal_id required");
  }
  if (!constraint.expectedRevisionHash.trim()) {
    throw new ToolInputError("operator-reviewed expected_revision_hash required");
  }
  if (action !== "inspect" && action !== "revise") {
    throw new ToolInputError(
      "this operator-requested Skill Workshop turn can only inspect or revise its reviewed proposal",
    );
  }
  const proposalId = readToolStringParam(params, "proposal_id", { label: "proposal_id" });
  if (proposalId && proposalId !== constraint.proposalId) {
    throw new ToolInputError("proposal_id conflicts with the operator-reviewed proposal");
  }
  if (readToolStringParam(params, "name")) {
    throw new ToolInputError("name cannot replace the operator-reviewed proposal_id");
  }
  const expectedRevisionHash = readToolStringParam(params, "expected_revision_hash");
  if (expectedRevisionHash && expectedRevisionHash !== constraint.expectedRevisionHash) {
    throw new ToolInputError(
      "expected_revision_hash conflicts with the operator-reviewed proposal revision",
    );
  }
  return {
    ...params,
    proposal_id: constraint.proposalId,
    expected_revision_hash: constraint.expectedRevisionHash,
  };
}

export type SkillWorkshopToolOptions = {
  libraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
  workspaceDir: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentId: string;
  origin?: SkillProposalOrigin;
  /** Internal reviewers may inspect and draft bounded pending proposals, never change lifecycle state. */
  proposalOnly?: boolean;
  /** Allows proposal-only sessions to draft update proposals for existing live skills. */
  updateProposals?: boolean;
  /** Marks proposals created by an autonomous capture pipeline. */
  autonomousCapture?: boolean;
  /** Run-scoped budget shared by every tool instance created across retries. */
  proposalMutationBudget?: SkillWorkshopProposalMutationBudget;
  /** Effective selected-model context used for every model-visible Workshop projection. */
  modelContextWindowTokens?: number;
  /** Exact proposal revision reviewed before this operator-requested revision turn. */
  proposalRevision?: SkillWorkshopProposalRevisionConstraint;
};

/** Create the Skill Workshop tool for proposal discovery and lifecycle actions. */
export function createSkillWorkshopTool(options: SkillWorkshopToolOptions): AnyAgentTool {
  if (options.libraryAuthoring) {
    return createLibrarySkillWorkshopTool(
      options.libraryAuthoring,
      options.libraryAuthoring.defaultTarget === "workspace"
        ? createWorkspaceSkillWorkshopTool(options)
        : undefined,
    );
  }
  return createWorkspaceSkillWorkshopTool(options);
}

function createWorkspaceSkillWorkshopTool(options: SkillWorkshopToolOptions): AnyAgentTool {
  const libraryAuthoring = options.libraryAuthoring;
  const workshopConfig = resolveSkillWorkshopConfig(options.config);
  const projectionBudgets = resolveSkillWorkshopProjectionBudgets(options.modelContextWindowTokens);
  const readSkillHashes =
    options.proposalMutationBudget?.readSkillHashes ?? new Map<string, string>();
  const preparedSkillPatches: NonNullable<
    SkillWorkshopProposalMutationBudget["preparedSkillPatches"]
  > = options.proposalMutationBudget?.preparedSkillPatches ?? new Map();
  if (options.proposalMutationBudget) {
    options.proposalMutationBudget.readSkillHashes = readSkillHashes;
    options.proposalMutationBudget.preparedSkillPatches = preparedSkillPatches;
  }
  return {
    label: "Skill Workshop",
    name: "skill_workshop",
    displaySummary: "Propose or improve a reusable skill",
    description: buildSkillWorkshopToolDescription({
      autonomousMode: workshopConfig.autonomous.mode,
      proposalRevision: options.proposalRevision !== undefined,
    }),
    parameters: buildSkillWorkshopToolSchema(options.proposalRevision !== undefined),
    execute: async (_toolCallId, args, signal) => {
      // Capture this invocation, not construction or a later ambient caller after loading.
      const assertCurrent = captureAgentToolSourceExecutionGuard(signal);
      assertCurrent();
      const rawParams = asToolParamsRecord(args);
      const action = readToolStringParam(rawParams, "action", { required: true });
      const params = bindProposalRevisionConstraint(rawParams, action, options.proposalRevision);
      const proposalActions = resolveProposalOnlyActions(options.updateProposals === true);

      if (options.proposalOnly === true && !proposalActions.includes(action)) {
        throw new ToolInputError(
          `this Skill Workshop review allows only: ${proposalActions.join(", ")}`,
        );
      }

      const { executeSkillWorkshopAction } = await loadExecution();
      assertCurrent();
      libraryAuthoring?.assertWorkspaceCurrent?.();
      return executeSkillWorkshopAction(options, {
        action,
        params,
        workshopConfig,
        projectionBudgets,
        readSkillHashes,
        preparedSkillPatches,
      });
    },
  };
}
