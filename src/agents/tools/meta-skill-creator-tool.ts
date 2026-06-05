import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AssistantMessage, Model } from "../../llm/types.js";
import { listReservedChatSlashCommandNames } from "../../skills/discovery/chat-command-invocation.js";
import { normalizeSkillIndexName } from "../../skills/discovery/skill-index.js";
import {
  buildWorkspaceSkillStatus,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
} from "../../skills/discovery/status.js";
import { parseFrontmatter } from "../../skills/loading/frontmatter.js";
import { createSyntheticSourceInfo, type Skill } from "../../skills/loading/skill-contract.js";
import { summarizeMetaGateResults, type MetaGateResult } from "../../skills/meta/gates.js";
import type { MetaPlan } from "../../skills/meta/types.js";
import { scanSkillContent, scanSource } from "../../skills/security/scanner.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveSkillWorkshopConfig } from "../../skills/workshop/config.js";
import {
  renderProposalMarkdown,
  stripProposalFrontmatterForSkill,
} from "../../skills/workshop/frontmatter.js";
import { listSkillProposals } from "../../skills/workshop/service.js";
import type { SkillProposalSupportFileInput } from "../../skills/workshop/types.js";
import {
  createAgentMetaInvokePlanRunner,
  type MetaInvokeLlmCompletionOptions,
} from "../meta-invoke-runtime.js";
import {
  asToolParamsRecord,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";

const META_CREATOR_WRITABLE_SKILL_SOURCES = new Set([
  "openclaw-workspace",
  "agents-skills-project",
]);

const META_CREATOR_RESERVED_SKILL_NAMES = [
  "meta_invoke",
  "meta-skill-creator",
  "meta_skill_creator_prepare",
  "skill_workshop",
  "tool_call",
  "tool_describe",
  "tool_search",
  "tool_search_code",
] as const;

type CreatorWorkshopAction = "create" | "update" | "revise";

const MetaSkillCreatorPrepareToolSchema = Type.Object(
  {
    name: Type.String({
      description: "Human-facing skill name to propose.",
    }),
    description: Type.String({
      maxLength: 160,
      description: "Concise skill description; max 160 bytes.",
    }),
    workflow: Type.String({
      description: "Reusable workflow, procedure, or operating contract to capture.",
    }),
    content: Type.Optional(
      Type.String({
        description:
          "Optional full proposal markdown. If omitted, a governed proposal body is assembled from the collected fields.",
      }),
    ),
    trigger: Type.Optional(
      Type.String({
        description: "Optional invocation trigger or user phrase for the skill.",
      }),
    ),
    audience: Type.Optional(
      Type.String({
        description: "Optional target audience for the skill.",
      }),
    ),
    required_tools: Type.Optional(
      Type.Union([
        Type.String({
          description:
            "Optional comma-separated, newline-separated, or JSON-array string of tools the skill expects.",
        }),
        Type.Array(Type.String(), {
          description: "Optional list of tools the skill expects.",
        }),
      ]),
    ),
    support_files: Type.Optional(
      Type.Union([
        Type.String({
          description: "Optional JSON-array string of support files with path and content fields.",
        }),
        Type.Array(
          Type.Object(
            {
              path: Type.String({
                description:
                  "Relative support file path under assets/, examples/, references/, scripts/, or templates/.",
              }),
              content: Type.String({
                description: "Support file text content.",
              }),
            },
            { additionalProperties: false },
          ),
          {
            description: "Optional support files to include in the Skill Workshop proposal.",
          },
        ),
      ]),
    ),
    prior_context: Type.Optional(
      Type.String({
        description:
          "Optional relevant prior conversation, workflow notes, or harvested context to include in the proposal.",
      }),
    ),
    harvested_context: Type.Optional(
      Type.String({
        description:
          "Optional machine-harvested prior context, such as sanitized session history JSON.",
      }),
    ),
    risk_profile: Type.Optional(
      Type.String({
        description: "Optional risk notes or policy constraints for the proposed workflow.",
      }),
    ),
    representative_invocation: Type.Optional(
      Type.String({
        description:
          "Optional example invocation used as evidence for future runtime/e2e validation.",
      }),
    ),
    require_runtime_e2e: Type.Optional(
      Type.Boolean({
        description:
          "If true, block preparation unless a representative invocation is supplied for a future runtime gate.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type MetaSkillCreatorPrepareToolOptions = {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
};

/** Prepare a governed Skill Workshop proposal from meta-skill-creator inputs. */
export function createMetaSkillCreatorPrepareTool(
  options: MetaSkillCreatorPrepareToolOptions,
): AnyAgentTool {
  return {
    label: "Meta Skill Creator Prepare",
    name: "meta_skill_creator_prepare",
    displaySummary: "Prepare a skill proposal",
    description:
      "Normalize meta-skill-creator inputs, assemble proposal markdown when needed, and run creator lint/collision gates before sending a proposal to Skill Workshop.",
    parameters: MetaSkillCreatorPrepareToolSchema,
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const name = readStringParam(params, "name", { required: true });
      const description = readStringParam(params, "description", { required: true });
      const workflow = readStringParam(params, "workflow", { required: true });
      const trigger = readStringParam(params, "trigger");
      const audience = readStringParam(params, "audience");
      const riskProfile = readStringParam(params, "risk_profile", { label: "risk_profile" });
      const representativeInvocation = readStringParam(params, "representative_invocation", {
        label: "representative_invocation",
      });
      const requireRuntimeE2e = readBooleanParam(params, "require_runtime_e2e");
      const requiredTools = readCreatorStringArrayParam(params, "required_tools") ?? [];
      const supportFiles = readCreatorSupportFilesParam(params, "support_files") ?? [];
      const priorContext = readStringParam(params, "prior_context", { label: "prior_context" });
      const harvestedContext = readStringParam(params, "harvested_context", {
        label: "harvested_context",
      });
      const proposalContent =
        readStringParam(params, "content", { allowEmpty: false }) ??
        renderCreatorProposal({
          name,
          description,
          workflow,
          trigger,
          audience,
          requiredTools,
          supportFiles,
          priorContext,
          harvestedContext,
          riskProfile,
          representativeInvocation,
        });

      const skillKey = normalizeSkillIndexName(name);
      const gates = await buildCreatorGateResults({
        workspaceDir: options.workspaceDir,
        config: options.config,
        agentId: options.agentId,
        name,
        description,
        workflow,
        proposalContent,
        skillKey,
        representativeInvocation,
        requireRuntimeE2e,
      });
      const summary = summarizeMetaGateResults(gates);
      const gatesOk = summary.result === "passed";
      const workshopTarget = resolveCreatorWorkshopTarget({
        gates,
        name,
        skillKey,
      });
      const contentText = gatesOk
        ? `Prepared skill proposal for ${skillKey}.`
        : `Blocked skill proposal for ${skillKey || name}: ${summary.evidence}`;

      return {
        content: [{ type: "text" as const, text: contentText }],
        details: {
          name,
          description,
          workflow,
          skillKey,
          proposalContent,
          goal: `Create reusable skill proposal: ${skillKey || name}`,
          evidence: `meta-skill-creator prepare gates:\n${summary.evidence}`,
          gatesOk,
          gates,
          workshopAction: workshopTarget.action,
          workshopSkillName: workshopTarget.skillName,
          workshopProposalId: workshopTarget.proposalId,
          trigger,
          audience,
          requiredTools,
          supportFiles,
          priorContext,
          harvestedContext,
          riskProfile,
          representativeInvocation,
          nextAction: gatesOk ? `skill_workshop_${workshopTarget.action}` : "blocked",
        },
      };
    },
  };
}

function isCreatorWorkshopAction(value: unknown): value is CreatorWorkshopAction {
  return value === "create" || value === "update" || value === "revise";
}

function resolveCreatorWorkshopTarget(params: {
  gates: readonly MetaGateResult[];
  name: string;
  skillKey: string;
}): {
  action: CreatorWorkshopAction;
  skillName: string;
  proposalId?: string;
} {
  const collisionGate = params.gates.find((gate) => gate.name === "creator_collision");
  const evidence = collisionGate?.evidenceJson;
  const action = isCreatorWorkshopAction(evidence?.workshopAction)
    ? evidence.workshopAction
    : "create";
  const skillName =
    typeof evidence?.workshopSkillName === "string" && evidence.workshopSkillName.trim()
      ? evidence.workshopSkillName.trim()
      : params.name;
  const proposalId =
    typeof evidence?.proposalId === "string" && evidence.proposalId.trim()
      ? evidence.proposalId.trim()
      : undefined;
  return {
    action,
    skillName,
    ...(proposalId ? { proposalId } : {}),
  };
}

async function buildCreatorGateResults(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  name: string;
  description: string;
  workflow: string;
  proposalContent: string;
  skillKey: string;
  representativeInvocation?: string;
  requireRuntimeE2e?: boolean;
}): Promise<MetaGateResult[]> {
  return [
    buildCreatorLintGate(params),
    await buildCreatorCollisionGate(params),
    await buildCreatorRuntimeE2eGate(params),
  ];
}

function buildCreatorLintGate(params: {
  config?: OpenClawConfig;
  name: string;
  description: string;
  workflow: string;
  proposalContent: string;
  skillKey: string;
}): MetaGateResult {
  const maxSkillBytes = resolveSkillWorkshopConfig(params.config).maxSkillBytes;
  const failures: string[] = [];
  const descriptionBytes = Buffer.byteLength(params.description, "utf8");
  const proposalBytes = Buffer.byteLength(params.proposalContent, "utf8");

  if (!params.skillKey) {
    failures.push("name must normalize to a non-empty skill key");
  }
  if (descriptionBytes > 160) {
    failures.push(`description is ${descriptionBytes} bytes; max is 160`);
  }
  if (proposalBytes > maxSkillBytes) {
    failures.push(`proposal content is ${proposalBytes} bytes; max is ${maxSkillBytes}`);
  }
  if (!/^#\s+\S+/m.test(params.proposalContent)) {
    failures.push("proposal content must include a markdown H1");
  }
  if (params.workflow.length < 20) {
    failures.push("workflow should describe a reusable procedure");
  }

  return {
    name: "creator_lint",
    result: failures.length > 0 ? "failed" : "passed",
    riskLevel: failures.length > 0 ? "high" : "low",
    summary: failures.length > 0 ? failures.join("; ") : "inputs are proposal-ready",
    evidenceJson: {
      skillKey: params.skillKey,
      descriptionBytes,
      proposalBytes,
      maxSkillBytes,
    },
  };
}

async function buildCreatorCollisionGate(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  name: string;
  skillKey: string;
}): Promise<MetaGateResult> {
  if (!params.skillKey) {
    return {
      name: "creator_collision",
      result: "failed",
      riskLevel: "high",
      summary: "skill key could not be resolved",
    };
  }

  const reservedName = resolveReservedCreatorSkillName(params);
  if (reservedName) {
    return {
      name: "creator_collision",
      result: "failed",
      riskLevel: "high",
      summary: `reserved skill name ${reservedName} cannot be proposed`,
      evidenceJson: {
        reservedName,
        skillKey: params.skillKey,
      },
    };
  }

  const pending = (await listSkillProposals({ workspaceDir: params.workspaceDir })).proposals.find(
    (proposal) => proposal.status === "pending" && proposal.skillKey === params.skillKey,
  );
  if (pending) {
    return {
      name: "creator_collision",
      result: "passed",
      riskLevel: "medium",
      summary: `pending proposal ${pending.id} will be revised by Skill Workshop`,
      evidenceJson: {
        proposalId: pending.id,
        proposalKind: pending.kind,
        skillKey: params.skillKey,
        workshopAction: "revise",
        workshopSkillName: params.name,
      },
    };
  }

  const liveSkill = resolveLiveSkill(params);
  if (!liveSkill) {
    return {
      name: "creator_collision",
      result: "passed",
      riskLevel: "low",
      summary: "no existing live skill or pending proposal with this key",
      evidenceJson: {
        skillKey: params.skillKey,
        workshopAction: "create",
        workshopSkillName: params.name,
      },
    };
  }
  if (META_CREATOR_WRITABLE_SKILL_SOURCES.has(liveSkill.source)) {
    return {
      name: "creator_collision",
      result: "passed",
      riskLevel: "medium",
      summary: `existing writable skill from ${liveSkill.source} will become an update proposal`,
      evidenceJson: {
        source: liveSkill.source,
        filePath: liveSkill.filePath,
        skillKey: params.skillKey,
        workshopAction: "update",
        workshopSkillName: liveSkill.name,
      },
    };
  }
  return {
    name: "creator_collision",
    result: "failed",
    riskLevel: "high",
    summary: `existing non-writable skill from ${liveSkill.source} must not be overwritten`,
    evidenceJson: {
      source: liveSkill.source,
      filePath: liveSkill.filePath,
    },
  };
}

function addCreatorReservedNameCandidates(names: Set<string>, value: string): void {
  const lowered = value.trim().toLowerCase();
  if (lowered) {
    names.add(lowered);
  }
  const skillKey = normalizeSkillIndexName(value);
  if (skillKey) {
    names.add(skillKey);
  }
}

function buildCreatorReservedNameSet(): Set<string> {
  const names = new Set<string>();
  for (const reservedName of listReservedChatSlashCommandNames([
    ...META_CREATOR_RESERVED_SKILL_NAMES,
  ])) {
    addCreatorReservedNameCandidates(names, reservedName);
  }
  return names;
}

function resolveReservedCreatorSkillName(params: {
  name: string;
  skillKey: string;
}): string | null {
  const reservedNames = buildCreatorReservedNameSet();
  if (reservedNames.has(params.skillKey)) {
    return params.skillKey;
  }
  const candidates = new Set<string>();
  addCreatorReservedNameCandidates(candidates, params.name);
  for (const candidate of candidates) {
    if (reservedNames.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveLiveSkill(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  name: string;
}): SkillStatusEntry | null {
  const status = buildWorkspaceSkillStatus(params.workspaceDir, {
    config: params.config,
    agentId: params.agentId,
  });
  return resolveSkillStatusEntry(status.skills, params.name);
}

async function buildCreatorRuntimeE2eGate(params: {
  name: string;
  description: string;
  proposalContent: string;
  skillKey: string;
  representativeInvocation?: string;
  requireRuntimeE2e?: boolean;
}): Promise<MetaGateResult> {
  const representativeInvocation = params.representativeInvocation;
  if (!representativeInvocation) {
    return {
      name: "creator_runtime_e2e",
      result: params.requireRuntimeE2e ? "failed" : "skipped",
      riskLevel: params.requireRuntimeE2e ? "high" : "medium",
      summary: params.requireRuntimeE2e
        ? "representative_invocation required for runtime e2e gate"
        : "runtime e2e not requested at prepare time",
    };
  }

  const validation = validateCreatorRuntimeProposal({
    ...params,
    representativeInvocation,
  });
  if (validation.failures.length > 0) {
    return {
      name: "creator_runtime_e2e",
      result: "failed",
      riskLevel: "high",
      summary: validation.failures.join("; "),
      evidenceJson: validation.evidenceJson,
    };
  }

  const probe = await runCreatorRuntimeE2eProbe({
    evidenceJson: validation.evidenceJson,
    skillContent: validation.skillContent,
  });
  if (probe.failures.length > 0) {
    return {
      name: "creator_runtime_e2e",
      result: "failed",
      riskLevel: "high",
      summary: probe.failures.join("; "),
      evidenceJson: probe.evidenceJson,
    };
  }

  return {
    name: "creator_runtime_e2e",
    result: "passed",
    riskLevel:
      validation.evidenceJson.scanWarn > 0 || probe.evidenceJson.runtimeStatus !== "succeeded"
        ? "medium"
        : "low",
    summary: "representative invocation executed through default meta skill_exec executor",
    evidenceJson: {
      ...validation.evidenceJson,
      ...probe.evidenceJson,
    },
    artifactRefsJson: {
      invocation: `meta://runtime-e2e/${validation.evidenceJson.skillKey}`,
      probe: "meta-skill-creator-runtime-e2e",
    },
  };
}

function createRuntimeProbeModel(): Model<"openai-responses"> {
  return {
    provider: "openai",
    id: "meta-skill-creator-runtime-e2e",
    name: "meta-skill-creator-runtime-e2e",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function createRuntimeProbeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "meta-skill-creator-runtime-e2e",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function readRuntimeProbePrompt(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  return messages
    .flatMap((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return [];
      }
      const content = (message as { content?: unknown }).content;
      return typeof content === "string" ? [content] : [];
    })
    .join("\n");
}

function buildRuntimeProbeSkillSnapshot(params: {
  validation: CreatorRuntimeProposalEvidence;
  skillContent: string;
}): SkillSnapshot {
  const filePath = `meta://runtime-e2e/${params.validation.skillKey}/SKILL.md`;
  const baseDir = `meta://runtime-e2e/${params.validation.skillKey}`;
  const skill: Skill = {
    name: params.validation.parsedName,
    description: params.validation.parsedDescription,
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, {
      source: "meta-skill-creator-runtime-e2e",
      scope: "temporary",
      baseDir,
    }),
    disableModelInvocation: false,
    source: params.skillContent,
  };
  return {
    prompt: "",
    skills: [{ name: skill.name }],
    resolvedSkills: [skill],
  };
}

function createRuntimeProbeLlmCompletion(
  validation: CreatorRuntimeProposalEvidence,
): MetaInvokeLlmCompletionOptions {
  const model = createRuntimeProbeModel();
  return {
    config: {},
    agentId: "meta-skill-creator-runtime-e2e",
    prepareSimpleCompletionModelForAgent: async () => ({
      selection: {
        provider: model.provider,
        modelId: model.id,
        agentDir: "/tmp/openclaw-meta-skill-creator-runtime-e2e",
      },
      model,
      auth: {
        apiKey: "meta-skill-creator-runtime-e2e-local-placeholder",
        source: "runtime-e2e",
        mode: "api-key",
      },
    }),
    completeWithPreparedSimpleCompletionModel: async (params) => {
      const prompt = readRuntimeProbePrompt(params.context.messages);
      if (!prompt.includes(validation.representativeInvocation)) {
        throw new Error(
          "runtime e2e default skill_exec executor omitted representative invocation",
        );
      }
      if (!prompt.includes(validation.parsedName)) {
        throw new Error("runtime e2e default skill_exec executor omitted parsed skill name");
      }
      return createRuntimeProbeAssistantMessage(
        `Runtime skill_exec executor validated ${validation.parsedName} for ${validation.representativeInvocation}`,
      );
    },
  };
}

async function runCreatorRuntimeE2eProbe(params: {
  evidenceJson: CreatorRuntimeProposalEvidence;
  skillContent: string;
}): Promise<{
  failures: string[];
  evidenceJson: {
    runtimeStatus: string;
    runtimeFinalText: string;
    runtimeStepIds: string[];
    runtimeStepKinds: string[];
    executedSkillName: string;
    runtimeExecutor: string;
  };
}> {
  const validation = params.evidenceJson;
  const plan = {
    name: "meta-skill-creator-runtime-e2e",
    description: "Probe meta runtime skill execution for a prepared skill proposal.",
    triggers: [],
    steps: [
      {
        id: "execute_candidate_skill",
        kind: "skill_exec",
        dependsOn: [],
        skillName: validation.parsedName,
        prompt: "{{input.representativeInvocation}}",
        args: {
          representativeInvocation: "{{input.representativeInvocation}}",
          skillKey: "{{input.skillKey}}",
          parsedName: "{{input.parsedName}}",
          parsedDescription: "{{input.parsedDescription}}",
          scanCritical: "{{input.scanCritical}}",
        },
        onFailure: { kind: "fail" },
      },
    ],
    finalTextMode: { kind: "step", stepId: "execute_candidate_skill" },
  } satisfies MetaPlan;
  const result = await createAgentMetaInvokePlanRunner({
    toolsRef: { current: [] },
    skillsSnapshot: buildRuntimeProbeSkillSnapshot({
      validation,
      skillContent: params.skillContent,
    }),
    llmCompletion: createRuntimeProbeLlmCompletion(validation),
  })({
    plan,
    input: {
      representativeInvocation: validation.representativeInvocation,
      skillKey: validation.skillKey,
      parsedName: validation.parsedName,
      parsedDescription: validation.parsedDescription,
      scanCritical: validation.scanCritical,
    },
  });
  const evidenceJson = {
    runtimeStatus: result.status,
    runtimeFinalText: result.finalText,
    runtimeStepIds: Object.keys(result.steps),
    runtimeStepKinds: plan.steps.map((step) => step.kind),
    executedSkillName: validation.parsedName,
    runtimeExecutor: "createAgentMetaInvokePlanRunner.skill_exec",
  };
  return {
    failures: result.status === "succeeded" ? [] : [`runtime probe ${result.status}`],
    evidenceJson,
  };
}

type CreatorRuntimeProposalEvidence = {
  representativeInvocation: string;
  skillKey: string;
  parsedName: string;
  parsedDescription: string;
  scanCritical: number;
  scanWarn: number;
  scanInfo: number;
  findings: Array<{
    ruleId: string;
    severity: string;
    file: string;
    line: number;
    message: string;
  }>;
};

function validateCreatorRuntimeProposal(params: {
  name: string;
  description: string;
  proposalContent: string;
  skillKey: string;
  representativeInvocation: string;
}): {
  failures: string[];
  evidenceJson: CreatorRuntimeProposalEvidence;
  skillContent: string;
} {
  const proposalMarkdown = renderProposalMarkdown({
    name: params.skillKey || params.name,
    description: params.description,
    content: params.proposalContent,
  });
  const skillContent = stripProposalFrontmatterForSkill(proposalMarkdown);
  const frontmatter = parseFrontmatter(skillContent);
  const parsedName = frontmatter.name?.trim() ?? "";
  const parsedDescription = frontmatter.description?.trim() ?? "";
  const findings = [
    ...scanSkillContent(proposalMarkdown, "PROPOSAL.md"),
    ...scanSource(proposalMarkdown, "PROPOSAL.md"),
  ];
  const criticalFindings = findings.filter((finding) => finding.severity === "critical");
  const warnFindings = findings.filter((finding) => finding.severity === "warn");
  const infoFindings = findings.filter((finding) => finding.severity === "info");
  const failures: string[] = [];

  if (!parsedName) {
    failures.push("rendered proposal does not produce loadable skill frontmatter name");
  }
  if (!parsedDescription) {
    failures.push("rendered proposal does not produce loadable skill frontmatter description");
  }
  if (params.skillKey && normalizeSkillIndexName(parsedName) !== params.skillKey) {
    failures.push(
      `rendered proposal skill name ${parsedName || "<empty>"} does not match ${params.skillKey}`,
    );
  }
  if (criticalFindings.length > 0) {
    failures.push(
      `proposal scan found critical issue(s): ${criticalFindings
        .map((finding) => finding.ruleId)
        .join(", ")}`,
    );
  }

  return {
    failures,
    evidenceJson: {
      representativeInvocation: params.representativeInvocation,
      skillKey: params.skillKey,
      parsedName,
      parsedDescription,
      scanCritical: criticalFindings.length,
      scanWarn: warnFindings.length,
      scanInfo: infoFindings.length,
      findings: findings.map((finding) => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        message: finding.message,
      })),
    },
    skillContent,
  };
}

function renderCreatorProposal(params: {
  name: string;
  description: string;
  workflow: string;
  trigger?: string;
  audience?: string;
  requiredTools: string[];
  supportFiles: SkillProposalSupportFileInput[];
  priorContext?: string;
  harvestedContext?: string;
  riskProfile?: string;
  representativeInvocation?: string;
}): string {
  const requiredTools =
    params.requiredTools.length > 0
      ? params.requiredTools.map((tool) => `- ${tool}`).join("\n")
      : "- None declared.";
  const representativeInvocation = params.representativeInvocation
    ? ["", "## Representative Invocation", "", params.representativeInvocation]
    : [];
  const supportFiles =
    params.supportFiles.length > 0
      ? params.supportFiles.map((file) => `- \`${file.path}\``).join("\n")
      : "- None declared.";
  const priorContext = params.priorContext ? ["", "## Prior Context", "", params.priorContext] : [];
  const harvestedContext = params.harvestedContext
    ? ["", "## Harvested Context", "", params.harvestedContext]
    : [];

  return [
    `# ${params.name}`,
    "",
    "## Purpose",
    "",
    params.description,
    "",
    "## Trigger",
    "",
    params.trigger ?? "Manual invocation or explicit user request.",
    "",
    "## Audience",
    "",
    params.audience ?? "OpenClaw users",
    "",
    "## Workflow",
    "",
    params.workflow,
    "",
    "## Required Tools",
    "",
    requiredTools,
    "",
    "## Support Files",
    "",
    supportFiles,
    ...priorContext,
    ...harvestedContext,
    "",
    "## Risk Profile",
    "",
    params.riskProfile ?? "standard",
    "",
    "## Validation Notes",
    "",
    "- Created through meta-skill-creator prepare gate.",
    ...representativeInvocation,
    "",
  ].join("\n");
}

function readCreatorSupportFilesParam(
  params: Record<string, unknown>,
  key: string,
): SkillProposalSupportFileInput[] | undefined {
  const raw = params[key];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseMaybeJsonArray(raw, key);
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ToolInputError(`${key}[${index}] must be an object`);
    }
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !file.path.trim()) {
      throw new ToolInputError(`${key}[${index}].path required`);
    }
    if (typeof file.content !== "string") {
      throw new ToolInputError(`${key}[${index}].content required`);
    }
    return {
      path: file.path.trim(),
      content: file.content,
    };
  });
}

function parseMaybeJsonArray(raw: unknown, label: string): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw !== "string") {
    throw new ToolInputError(`${label} must be an array`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the user-facing validation error below.
  }
  throw new ToolInputError(`${label} must be an array`);
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = params[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) {
      return undefined;
    }
    if (["true", "1", "yes"].includes(trimmed)) {
      return true;
    }
    if (["false", "0", "no"].includes(trimmed)) {
      return false;
    }
  }
  throw new ToolInputError(`${key} must be a boolean`);
}

function readCreatorStringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const raw = params[key];
  if (raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    return normalizeCreatorStringEntries(raw);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return normalizeCreatorStringEntries(parsed);
        }
      } catch {
        // Fall through to delimiter parsing for user-provided text.
      }
    }
    return normalizeCreatorStringEntries(trimmed.split(/[\n,]+/));
  }
  throw new ToolInputError(`${key} must be a string array`);
}

function normalizeCreatorStringEntries(entries: unknown[]): string[] | undefined {
  const normalized = entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}
