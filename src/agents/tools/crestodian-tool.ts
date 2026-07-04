/**
 * crestodian built-in tool: ring-zero setup/repair actions for the Crestodian
 * agent. Never exposed to normal agents — construction is gated on an explicit
 * runner option, and every action funnels through Crestodian's typed operation
 * union with approval assertions and the audit log.
 */
import { Type } from "typebox";
import {
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  type CrestodianOperation,
} from "../../crestodian/operations.js";
import type { RuntimeEnv } from "../../runtime.js";
import { stringEnum } from "../schema/typebox.js";
import { textResult, ToolInputError, readStringParam, type AnyAgentTool } from "./common.js";

export type CrestodianToolOptions = {
  /** Where setup side effects run; the gateway surface never manages its own daemon. */
  surface: "cli" | "gateway";
};

const CRESTODIAN_TOOL_ACTIONS = [
  "status",
  "models",
  "agents",
  "channels",
  "audit",
  "validate_config",
  "doctor",
  "config_get",
  "config_schema",
  "gateway_status",
  "plugin_search",
  // Mutating actions below require approved=true.
  "setup",
  "set_default_model",
  "config_set",
  "config_set_ref",
  "create_agent",
  "gateway_start",
  "gateway_stop",
  "gateway_restart",
  "plugin_install",
  "plugin_uninstall",
  "doctor_fix",
] as const;

const CrestodianToolSchema = Type.Object({
  action: stringEnum([...CRESTODIAN_TOOL_ACTIONS]),
  path: Type.Optional(Type.String({ description: "Config path for config_* actions" })),
  value: Type.Optional(Type.String({ description: "Value for config_set (JSON5 or string)" })),
  envVar: Type.Optional(Type.String({ description: "Env var name for config_set_ref" })),
  model: Type.Optional(Type.String({ description: "provider/model ref" })),
  workspace: Type.Optional(Type.String({ description: "Workspace directory" })),
  agentId: Type.Optional(Type.String({ description: "Agent id for create_agent" })),
  query: Type.Optional(Type.String({ description: "Search query for plugin_search" })),
  spec: Type.Optional(Type.String({ description: "npm/clawhub spec for plugin_install" })),
  pluginId: Type.Optional(Type.String({ description: "Plugin id for plugin_uninstall" })),
  approved: Type.Optional(
    Type.Boolean({
      description:
        "Set true ONLY after the user explicitly approved this exact change in the conversation.",
    }),
  ),
});

function createCaptureRuntime(): RuntimeEnv & { read: () => string } {
  const lines: string[] = [];
  return {
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
    exit: (code) => {
      throw new Error(`crestodian operation exited with code ${String(code)}`);
    },
    read: () => lines.join("\n").trim(),
  };
}

function requireParam(params: Record<string, unknown>, name: string): string {
  const value = readStringParam(params, name);
  if (!value?.trim()) {
    throw new ToolInputError(`crestodian: "${name}" is required for this action`);
  }
  return value.trim();
}

function operationForAction(params: Record<string, unknown>): CrestodianOperation {
  const action = readStringParam(params, "action", { required: true });
  switch (action) {
    case "status":
      return { kind: "status" };
    case "models":
      return { kind: "models" };
    case "agents":
      return { kind: "agents" };
    case "channels":
      return { kind: "channel-list" };
    case "audit":
      return { kind: "audit" };
    case "validate_config":
      return { kind: "config-validate" };
    case "doctor":
      return { kind: "doctor" };
    case "doctor_fix":
      return { kind: "doctor-fix" };
    case "config_get":
      return { kind: "config-get", path: requireParam(params, "path") };
    case "config_schema": {
      const path = readStringParam(params, "path")?.trim();
      return { kind: "config-schema", ...(path ? { path } : {}) };
    }
    case "gateway_status":
      return { kind: "gateway-status" };
    case "gateway_start":
      return { kind: "gateway-start" };
    case "gateway_stop":
      return { kind: "gateway-stop" };
    case "gateway_restart":
      return { kind: "gateway-restart" };
    case "plugin_search":
      return { kind: "plugin-search", query: requireParam(params, "query") };
    case "plugin_install":
      return { kind: "plugin-install", spec: requireParam(params, "spec") };
    case "plugin_uninstall":
      return { kind: "plugin-uninstall", pluginId: requireParam(params, "pluginId") };
    case "setup": {
      const workspace = readStringParam(params, "workspace")?.trim();
      const model = readStringParam(params, "model")?.trim();
      return {
        kind: "setup",
        ...(workspace ? { workspace } : {}),
        ...(model ? { model } : {}),
      };
    }
    case "set_default_model":
      return { kind: "set-default-model", model: requireParam(params, "model") };
    case "config_set":
      return {
        kind: "config-set",
        path: requireParam(params, "path"),
        value: requireParam(params, "value"),
      };
    case "config_set_ref":
      return {
        kind: "config-set-ref",
        path: requireParam(params, "path"),
        source: "env",
        id: requireParam(params, "envVar"),
      };
    default:
      throw new ToolInputError(`crestodian: unknown action "${String(action)}"`);
  }
}

/** Validate openclaw.json after a write so the agent can fix mistakes in-loop. */
async function verifyConfigAfterToolWrite(): Promise<string | null> {
  try {
    const { readConfigFileSnapshot } = await import("../../config/config.js");
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.exists || snapshot.valid) {
      return null;
    }
    const issues = (snapshot.issues ?? []).map(
      (issue: { path?: string; message: string }) =>
        `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
    );
    return [
      "CONFIG INVALID after this write — fix it before doing anything else:",
      ...(issues.length > 0 ? issues : ["unknown validation failure"]),
    ].join("\n");
  } catch {
    return null;
  }
}

export function createCrestodianTool(options: CrestodianToolOptions): AnyAgentTool {
  return {
    name: "crestodian",
    label: "Crestodian",
    description: [
      "Ring-zero OpenClaw setup and repair. Read actions (status/models/agents/channels/config_get/config_schema/gateway_status/plugin_search/validate_config/doctor/audit) run immediately.",
      "Mutating actions (setup/set_default_model/config_set/config_set_ref/create_agent/gateway_*/plugin_install/plugin_uninstall/doctor_fix) REQUIRE approved=true, which you may only set after the user explicitly said yes to that exact change in this conversation.",
      "Before writing an unfamiliar config path, call config_schema for it — the schema is the source of truth. Secrets go through config_set_ref (env var), never plaintext echoes.",
      "Every applied write is validated; if the result reports CONFIG INVALID, fix it immediately. All writes are audited.",
    ].join(" "),
    parameters: CrestodianToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const operation = operationForAction(params);
      const persistent = isPersistentCrestodianOperation(operation);
      if (persistent && params.approved !== true) {
        return textResult(
          "needs-approval: this action changes state. Ask the user to confirm the exact change, then retry with approved=true.",
          { needsApproval: true },
        );
      }
      const capture = createCaptureRuntime();
      let applied = false;
      try {
        const result = await executeCrestodianOperation(operation, capture, {
          approved: persistent,
          deps: { setupSurface: options.surface },
          auditDetails: { via: "crestodian-agent-tool" },
        });
        applied = result.applied;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult([capture.read(), `error: ${message}`].filter(Boolean).join("\n"), {
          error: true,
        });
      }
      const verify = applied ? await verifyConfigAfterToolWrite() : null;
      return textResult(
        [capture.read() || "done", verify].filter(Boolean).join("\n\n"),
        verify ? { configInvalid: true } : {},
      );
    },
  };
}
