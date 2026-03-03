import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

const TASK_HUB_URL = process.env.TASK_HUB_URL || "http://localhost:3102";

async function hubFetch(path: string, options?: RequestInit) {
  const optionHeaders =
    options?.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : Array.isArray(options?.headers)
        ? Object.fromEntries(options.headers)
        : options?.headers;
  const res = await fetch(`${TASK_HUB_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Cookie: "task-hub-session=authenticated",
      ...optionHeaders,
    },
  });
  return res.json();
}

export function createHarnessTools(): AnyAgentTool[] {
  const reportStep: AnyAgentTool = {
    name: "harness_report_step",
    label: "Harness Report Step",
    description:
      "Report completion of a harness spec step. Call this after completing each step in a harness-managed task. The step status is recorded in Task Hub for tracking.",
    parameters: Type.Object({
      item_id: Type.String(),
      step_index: Type.Number(),
      status: Type.Unsafe<string>({ type: "string", enum: ["done", "skipped"] }),
      note: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, args) => {
      const itemId = readStringParam(args, "item_id", { required: true });
      const stepIndex = readNumberParam(args, "step_index", { required: true });
      const status = readStringParam(args, "status", { required: true });
      const note = readStringParam(args, "note");

      const data = await hubFetch(`/api/harness/${itemId}/verify`, {
        method: "POST",
        body: JSON.stringify({
          type: "step",
          index: stepIndex,
          status,
          note,
        }),
      });

      if (data.error) {
        return jsonResult({ success: false, error: data.error });
      }

      return jsonResult({
        success: true,
        stepIndex,
        status,
        stepsRemaining: data.summary?.stepsRemaining ?? null,
        stepsDone: data.summary?.stepsDone ?? null,
        stepsTotal: data.summary?.stepsTotal ?? null,
        verificationStatus: data.verification?.status ?? null,
      });
    },
  };

  const reportCheck: AnyAgentTool = {
    name: "harness_report_check",
    label: "Harness Report Check",
    description:
      "Report result of a harness verification checklist item. Call this after verifying each checklist item in a harness-managed task. When all checks pass, the verification status is automatically set to 'passed'.",
    parameters: Type.Object({
      item_id: Type.String(),
      check_index: Type.Number(),
      passed: Type.Boolean(),
      note: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, args) => {
      const itemId = readStringParam(args, "item_id", { required: true });
      const checkIndex = readNumberParam(args, "check_index", { required: true });
      const rawPassed = (args as Record<string, unknown>).passed;
      const passed = rawPassed === true || rawPassed === "true";
      const note = readStringParam(args, "note");

      const data = await hubFetch(`/api/harness/${itemId}/verify`, {
        method: "POST",
        body: JSON.stringify({
          type: "check",
          index: checkIndex,
          status: passed,
          note,
        }),
      });

      if (data.error) {
        return jsonResult({ success: false, error: data.error });
      }

      return jsonResult({
        success: true,
        checkIndex,
        passed,
        checksRemaining: data.summary?.checksRemaining ?? null,
        checksPassed: data.summary?.checksPassed ?? null,
        checksTotal: data.summary?.checksTotal ?? null,
        verificationStatus: data.verification?.status ?? null,
        allChecksPassed: data.verification?.status === "passed",
      });
    },
  };

  return [reportStep, reportCheck];
}
