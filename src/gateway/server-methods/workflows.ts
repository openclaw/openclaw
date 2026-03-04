import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  ErrorCodes,
  errorShape,
  validateWorkflowsGetParams,
  validateWorkflowsSaveParams,
} from "../protocol/index.js";
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
        workflows = JSON.parse(data);
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
      respond(true, { ok: true }, undefined);
    } catch (err) {
      console.error("Failed to write workflows file", err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "failed to save workflows"));
    }
  },
};
