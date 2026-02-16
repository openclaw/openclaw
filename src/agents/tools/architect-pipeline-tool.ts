import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { ToolInputError, jsonResult, readNumberParam, readStringParam } from "./common.js";

const ARCHITECT_PIPELINE_ACTIONS = ["init", "get", "update", "decision_gate"] as const;
const ARCHITECT_PHASES = ["planning", "construction", "validation"] as const;
const ARCHITECT_STATUSES = ["running", "blocked", "complete", "escalated"] as const;
const ARCHITECT_REPORTS = ["PASS", "FAIL", "ERROR"] as const;

type ArchitectPipelineAction = (typeof ARCHITECT_PIPELINE_ACTIONS)[number];
type ArchitectPhase = (typeof ARCHITECT_PHASES)[number];
type ArchitectStatus = (typeof ARCHITECT_STATUSES)[number];
type ArchitectReport = (typeof ARCHITECT_REPORTS)[number];

type ArchitectState = {
  project: string;
  currentPhase: ArchitectPhase;
  currentStep: number;
  retryCount: number;
  status: ArchitectStatus;
  sharedContext: {
    conceptBriefPath: string;
    prdPath: string;
    wireframesPath: string;
    schemaPath: string;
    designSystemPath: string;
  };
  artifacts: {
    infraReady: boolean;
    codeReady: boolean;
    securityReportPath: string;
    deployInstructionsPath: string;
  };
  latestAudit?: {
    report: ArchitectReport;
    findings?: string;
    at: string;
    retryCount: number;
  };
};

const ArchitectPipelineToolSchema = Type.Object({
  action: optionalStringEnum(ARCHITECT_PIPELINE_ACTIONS),
  path: Type.Optional(Type.String()),
  project: Type.Optional(Type.String()),
  currentPhase: optionalStringEnum(ARCHITECT_PHASES),
  currentStep: Type.Optional(Type.Number({ minimum: 1 })),
  status: optionalStringEnum(ARCHITECT_STATUSES),
  retryCount: Type.Optional(Type.Number({ minimum: 0 })),
  conceptBriefPath: Type.Optional(Type.String()),
  prdPath: Type.Optional(Type.String()),
  wireframesPath: Type.Optional(Type.String()),
  schemaPath: Type.Optional(Type.String()),
  designSystemPath: Type.Optional(Type.String()),
  infraReady: Type.Optional(Type.Boolean()),
  codeReady: Type.Optional(Type.Boolean()),
  securityReportPath: Type.Optional(Type.String()),
  deployInstructionsPath: Type.Optional(Type.String()),
  report: optionalStringEnum(ARCHITECT_REPORTS),
  findings: Type.Optional(Type.String()),
  maxRetries: Type.Optional(Type.Number({ minimum: 1 })),
});

function defaultState(project = "unnamed-project"): ArchitectState {
  return {
    project,
    currentPhase: "planning",
    currentStep: 1,
    retryCount: 0,
    status: "running",
    sharedContext: {
      conceptBriefPath: "concept_brief.json",
      prdPath: "prd.md",
      wireframesPath: "wireframes.md",
      schemaPath: "data-schema.json",
      designSystemPath: "design-system.md",
    },
    artifacts: {
      infraReady: false,
      codeReady: false,
      securityReportPath: "security-report.md",
      deployInstructionsPath: "DEPLOY_INSTRUCTIONS.md",
    },
  };
}

function isWithinWorkspace(candidatePath: string, workspaceDir: string) {
  const rel = path.relative(workspaceDir, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveStatePath(params: { workspaceDir: string; rawPath?: string }) {
  const workspaceDir = path.resolve(params.workspaceDir);
  const rawPath = params.rawPath?.trim();
  const statePath = rawPath
    ? path.resolve(workspaceDir, rawPath)
    : path.join(workspaceDir, "state.json");
  if (!isWithinWorkspace(statePath, workspaceDir)) {
    throw new ToolInputError("path must stay within the workspace directory");
  }
  return statePath;
}

async function readState(statePath: string): Promise<ArchitectState | null> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as ArchitectState;
  } catch (error) {
    const anyErr = error as { code?: string };
    if (anyErr.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeState(statePath: string, state: ArchitectState) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function createArchitectPipelineTool(options: { workspaceDir: string }): AnyAgentTool {
  return {
    label: "Architect Pipeline",
    name: "architect_pipeline",
    description:
      "Manage Architect CEO orchestration state.json and enforce audit decision gates for retries/escalation.",
    parameters: ArchitectPipelineToolSchema,
    execute: async (_callId, input) => {
      const params = (input ?? {}) as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "get") as ArchitectPipelineAction;
      const statePath = resolveStatePath({
        workspaceDir: options.workspaceDir,
        rawPath: readStringParam(params, "path"),
      });

      if (action === "init") {
        const project = readStringParam(params, "project") ?? "unnamed-project";
        const state = defaultState(project);
        await writeState(statePath, state);
        return jsonResult({ action, path: statePath, state });
      }

      const current = await readState(statePath);
      if (!current) {
        throw new ToolInputError(
          `state file not found at ${statePath}. Run action=init first or provide an existing path.`,
        );
      }

      if (action === "get") {
        return jsonResult({ action, path: statePath, state: current });
      }

      if (action === "update") {
        const next: ArchitectState = {
          ...current,
          project: readStringParam(params, "project") ?? current.project,
          currentPhase:
            (readStringParam(params, "currentPhase") as ArchitectPhase | undefined) ??
            current.currentPhase,
          currentStep:
            readNumberParam(params, "currentStep", { integer: true }) ?? current.currentStep,
          retryCount:
            readNumberParam(params, "retryCount", { integer: true }) ?? current.retryCount,
          status:
            (readStringParam(params, "status") as ArchitectStatus | undefined) ?? current.status,
          sharedContext: {
            ...current.sharedContext,
            conceptBriefPath:
              readStringParam(params, "conceptBriefPath") ?? current.sharedContext.conceptBriefPath,
            prdPath: readStringParam(params, "prdPath") ?? current.sharedContext.prdPath,
            wireframesPath:
              readStringParam(params, "wireframesPath") ?? current.sharedContext.wireframesPath,
            schemaPath: readStringParam(params, "schemaPath") ?? current.sharedContext.schemaPath,
            designSystemPath:
              readStringParam(params, "designSystemPath") ?? current.sharedContext.designSystemPath,
          },
          artifacts: {
            ...current.artifacts,
            infraReady:
              typeof params.infraReady === "boolean"
                ? params.infraReady
                : current.artifacts.infraReady,
            codeReady:
              typeof params.codeReady === "boolean"
                ? params.codeReady
                : current.artifacts.codeReady,
            securityReportPath:
              readStringParam(params, "securityReportPath") ?? current.artifacts.securityReportPath,
            deployInstructionsPath:
              readStringParam(params, "deployInstructionsPath") ??
              current.artifacts.deployInstructionsPath,
          },
        };
        await writeState(statePath, next);
        return jsonResult({ action, path: statePath, state: next });
      }

      if (action === "decision_gate") {
        const report = (
          readStringParam(params, "report", { required: true }) as ArchitectReport
        ).toUpperCase() as ArchitectReport;
        const findings = readStringParam(params, "findings");
        const maxRetries = readNumberParam(params, "maxRetries", { integer: true }) ?? 5;
        const retryCount = report === "PASS" ? current.retryCount : current.retryCount + 1;
        const status: ArchitectStatus =
          report === "PASS" ? "complete" : retryCount >= maxRetries ? "escalated" : "running";
        const next: ArchitectState = {
          ...current,
          currentPhase: report === "PASS" ? "validation" : current.currentPhase,
          retryCount,
          status,
          latestAudit: {
            report,
            findings,
            at: new Date().toISOString(),
            retryCount,
          },
        };
        await writeState(statePath, next);
        const nextAction =
          report === "PASS"
            ? "package_app_and_generate_deploy_instructions"
            : status === "escalated"
              ? "escalate_to_human"
              : "send_findings_to_builder_then_reaudit";
        return jsonResult({
          action,
          path: statePath,
          report,
          status,
          retryCount,
          maxRetries,
          nextAction,
          state: next,
        });
      }

      throw new ToolInputError("Unknown action.");
    },
  };
}
