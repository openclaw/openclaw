import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  ErrorCodes,
  errorShape,
  validateWorkflowsGetParams,
  validateWorkflowsSaveParams,
} from "../protocol/index.js";
import { workflowTriggerService } from "../workflow-triggers.js";
import type { GatewayRequestHandlers } from "./types.js";

function getWorkflowsFilePath(): string {
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, "workflows", "workflows.json");
}

export const workflowsHandlers: GatewayRequestHandlers = {
  "workflows.get": ({ params, respond }) => {
    if (!validateWorkflowsGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid workflows.get params"),
      );
      return;
    }

    const filePath = getWorkflowsFilePath();
    let workflows = [];
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(data);
        // Handle both array and object with workflows property
        workflows = Array.isArray(parsed) ? parsed : parsed.workflows || [];
      }
    } catch (err) {
      console.error("Failed to read workflows file", err);
    }

    respond(true, { workflows }, undefined);
  },

  "workflows.save": ({ params, respond }) => {
    if (!validateWorkflowsSaveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid workflows.save params"),
      );
      return;
    }

    const { workflows } = params as { workflows: unknown[] };
    const filePath = getWorkflowsFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(workflows, null, 2), "utf-8");

      // Re-register all triggers from saved workflows
      workflowTriggerService.clearAllTriggers();
      for (const workflow of workflows) {
        if (workflow && typeof workflow === "object" && "triggerConfigs" in workflow) {
          const wf = workflow as { id?: string; triggerConfigs?: unknown[] };
          if (Array.isArray(wf.triggerConfigs)) {
            for (const trigger of wf.triggerConfigs) {
              if (trigger && typeof trigger === "object" && "type" in trigger) {
                const t = trigger as {
                  type: string;
                  workflowId?: string;
                  sessionKey?: string;
                  matchKeyword?: string;
                  enabled?: boolean;
                  cronJobId?: string;
                };
                if (t.type === "chat" && t.sessionKey) {
                  workflowTriggerService.registerChatTrigger({
                    workflowId: wf.id || "unknown",
                    sessionKey: t.sessionKey,
                    matchKeyword: t.matchKeyword,
                    cronJobId: t.cronJobId || "",
                    enabled: t.enabled !== false,
                  });
                }
              }
            }
          }
        }
      }

      respond(true, { ok: true }, undefined);
    } catch (err) {
      console.error("Failed to write workflows file", err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "failed to save workflows"));
    }
  },
};
