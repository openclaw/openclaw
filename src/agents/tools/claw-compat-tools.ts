import { setTimeout as sleepTimeout } from "node:timers/promises";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { Type } from "@sinclair/typebox";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "../../config/config-paths.js";
import { listCoreToolSections } from "../tool-catalog.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

function readNumberParam(input: Record<string, unknown>, key: string): number | undefined {
  const raw = input[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function readRecordParam(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const raw = input[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function getByPath(root: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function getTodoStorePath(): string {
  const configured = process.env.CLAWD_TODO_STORE?.trim();
  if (configured) {
    return configured;
  }
  return path.join(process.cwd(), ".clawd-todos.json");
}

function getPlanModeStatePath(): string {
  return path.join(process.cwd(), ".clawd-plan-mode-state.json");
}

type PermissionMode = "read-only" | "workspace-write" | "danger-full-access" | "plan";

function normalizePermissionMode(value: unknown): PermissionMode {
  if (typeof value !== "string") {
    return "workspace-write";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "read-only" || normalized === "readonly") {
    return "read-only";
  }
  if (normalized === "danger-full-access" || normalized === "danger") {
    return "danger-full-access";
  }
  if (normalized === "plan") {
    return "plan";
  }
  return "workspace-write";
}

function classifyActionKind(action: string): "read" | "write" | "exec" | "unknown" {
  const normalized = action.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (/(^|[_\-.])(read|get|list|show|status|probe|check|query|search|fetch|inspect)($|[_\-.])/.test(normalized)) {
    return "read";
  }
  if (/(^|[_\-.])(write|edit|update|patch|delete|remove|create|install|uninstall|enable|disable|set|apply|mutate)($|[_\-.])/.test(normalized)) {
    return "write";
  }
  if (/(^|[_\-.])(exec|run|bash|shell|command|spawn|trigger)($|[_\-.])/.test(normalized)) {
    return "exec";
  }
  return "unknown";
}

export function createAskUserQuestionCompatTool(): AnyAgentTool {
  return {
    name: "ask_user_question",
    label: "ask_user_question",
    description: "Compatibility bridge for claw-code AskUserQuestion tool.",
    parameters: Type.Object(
      {
        question: Type.String(),
        options: Type.Optional(Type.Array(Type.String())),
        answer: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 300000 })),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const question = readStringParam(params, "question", { required: true });
      const options = Array.isArray(params.options)
        ? params.options.filter((entry): entry is string => typeof entry === "string")
        : [];
      const explicitAnswer = readStringParam(params, "answer");
      if (explicitAnswer) {
        const resolvedByOption =
          options.length > 0 && /^[0-9]+$/.test(explicitAnswer)
            ? options[Number.parseInt(explicitAnswer, 10) - 1] ?? explicitAnswer
            : explicitAnswer;
        return jsonResult({
          status: "answered",
          question,
          options,
          answer: resolvedByOption,
          source: "argument",
        });
      }

      const envAnswer = process.env.OPENCLAW_ASK_USER_QUESTION_ANSWER?.trim();
      if (envAnswer) {
        const resolvedByOption =
          options.length > 0 && /^[0-9]+$/.test(envAnswer)
            ? options[Number.parseInt(envAnswer, 10) - 1] ?? envAnswer
            : envAnswer;
        return jsonResult({
          status: "answered",
          question,
          options,
          answer: resolvedByOption,
          source: "env",
        });
      }

      if (process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const timeoutMs = Math.max(1, Math.min(300000, Math.floor(readNumberParam(params, "timeoutMs") ?? 120000)));
          const prompt =
            options.length > 0
              ? `\n[Question] ${question}\n${options
                  .map((option, index) => `  ${index + 1}. ${option}`)
                  .join("\n")}\nEnter choice (1-${options.length}): `
              : `\n[Question] ${question}\nYour answer: `;
          const timeoutPromise = new Promise<string>((_resolve, reject) => {
            setTimeout(() => reject(new ToolInputError("ask_user_question timed out waiting for input")), timeoutMs);
          });
          const answerRaw = await Promise.race([rl.question(prompt), timeoutPromise]);
          const answerTrimmed = answerRaw.trim();
          const answer =
            options.length > 0 && /^[0-9]+$/.test(answerTrimmed)
              ? options[Number.parseInt(answerTrimmed, 10) - 1] ?? answerTrimmed
              : answerTrimmed;
          return jsonResult({
            status: "answered",
            question,
            options,
            answer,
            source: "tty",
          });
        } finally {
          rl.close();
        }
      }

      return jsonResult({
        status: "pending",
        question,
        options,
        note: "question captured; host interaction is handled outside this tool bridge.",
      });
    },
  };
}

export function createSendUserMessageCompatTool(): AnyAgentTool {
  return {
    name: "send_user_message",
    label: "send_user_message",
    description: "Compatibility bridge for claw-code SendUserMessage tool.",
    parameters: Type.Object({ message: Type.String() }, { additionalProperties: true }),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const message = readStringParam(params, "message", { required: true });
      return jsonResult({ status: "ok", delivered: true, message });
    },
  };
}

export function createEnterPlanModeCompatTool(): AnyAgentTool {
  return {
    name: "enter_plan_mode",
    label: "enter_plan_mode",
    description: "Compatibility bridge for claw-code EnterPlanMode tool.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => {
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      const nextCfg = structuredClone(cfg);
      const planPath = ["permissions", "defaultMode"];
      const statePath = getPlanModeStatePath();
      const current = getConfigValueAtPath(nextCfg, planPath);
      const currentIsPlan = current === "plan";

      if (currentIsPlan) {
        return jsonResult({
          success: true,
          operation: "enter",
          changed: false,
          active: true,
          managed: false,
          message:
            "Worktree-local plan mode is already enabled outside EnterPlanMode; leaving it unchanged.",
          previous_local_mode: null,
          current_local_mode: current,
          state_path: statePath,
        });
      }

      await fs.writeFile(
        statePath,
        JSON.stringify(
          {
            had_local_override: current !== undefined,
            previous_local_mode: current ?? null,
          },
          null,
          2,
        ),
        "utf8",
      );
      setConfigValueAtPath(nextCfg, planPath, "plan");
      await writeConfigFile(nextCfg);
      return jsonResult({
        success: true,
        operation: "enter",
        changed: true,
        active: true,
        managed: true,
        message: "Enabled worktree-local plan mode override.",
        previous_local_mode: current ?? null,
        current_local_mode: "plan",
        state_path: statePath,
      });
    },
  };
}

export function createExitPlanModeCompatTool(): AnyAgentTool {
  return {
    name: "exit_plan_mode",
    label: "exit_plan_mode",
    description: "Compatibility bridge for claw-code ExitPlanMode tool.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => {
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      const nextCfg = structuredClone(cfg);
      const planPath = ["permissions", "defaultMode"];
      const statePath = getPlanModeStatePath();
      const current = getConfigValueAtPath(nextCfg, planPath);
      const currentIsPlan = current === "plan";

      let rawState: {
        had_local_override?: boolean;
        previous_local_mode?: unknown;
      } | null = null;
      try {
        rawState = JSON.parse(await fs.readFile(statePath, "utf8")) as {
          had_local_override?: boolean;
          previous_local_mode?: unknown;
        };
      } catch {
        rawState = null;
      }

      if (!rawState) {
        return jsonResult({
          success: true,
          operation: "exit",
          changed: false,
          active: currentIsPlan,
          managed: false,
          message: "No EnterPlanMode override is active for this worktree.",
          previous_local_mode: null,
          current_local_mode: current ?? null,
          state_path: statePath,
        });
      }

      if (!currentIsPlan) {
        await fs.rm(statePath, { force: true });
        return jsonResult({
          success: true,
          operation: "exit",
          changed: false,
          active: false,
          managed: false,
          message: "Cleared stale EnterPlanMode state because plan mode was already changed outside the tool.",
          previous_local_mode: rawState.previous_local_mode ?? null,
          current_local_mode: current ?? null,
          state_path: statePath,
        });
      }

      if (rawState.had_local_override) {
        if (rawState.previous_local_mode === null || rawState.previous_local_mode === undefined) {
          unsetConfigValueAtPath(nextCfg, planPath);
        } else {
          setConfigValueAtPath(nextCfg, planPath, rawState.previous_local_mode);
        }
      } else {
        unsetConfigValueAtPath(nextCfg, planPath);
      }
      await writeConfigFile(nextCfg);
      await fs.rm(statePath, { force: true });
      return jsonResult({
        success: true,
        operation: "exit",
        changed: true,
        active: false,
        managed: false,
        message: "Restored the prior worktree-local plan mode setting.",
        previous_local_mode: rawState.previous_local_mode ?? null,
        current_local_mode: getConfigValueAtPath(nextCfg, planPath) ?? null,
        state_path: statePath,
      });
    },
  };
}

export function createStructuredOutputCompatTool(): AnyAgentTool {
  return {
    name: "structured_output",
    label: "structured_output",
    description: "Compatibility bridge for claw-code StructuredOutput tool.",
    parameters: Type.Object(
      {
        value: Type.Optional(Type.Unknown()),
        data: Type.Optional(Type.Unknown()),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const payload = params.value ?? params.data ?? params;
      if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        Object.keys(payload as Record<string, unknown>).length === 0
      ) {
        throw new ToolInputError("structured output payload must not be empty");
      }
      return jsonResult({
        status: "ok",
        output: payload,
      });
    },
  };
}

export function createSleepCompatTool(): AnyAgentTool {
  return {
    name: "sleep",
    label: "sleep",
    description: "Compatibility bridge for claw-code Sleep tool.",
    parameters: Type.Object(
      {
        ms: Type.Optional(Type.Number({ minimum: 0 })),
        seconds: Type.Optional(Type.Number({ minimum: 0 })),
        duration_ms: Type.Optional(Type.Number({ minimum: 0 })),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const durationMs = readNumberParam(params, "duration_ms");
      const msFromMs = readNumberParam(params, "ms");
      const seconds = readNumberParam(params, "seconds");
      const sleepMs =
        durationMs !== undefined
          ? Math.max(0, Math.floor(durationMs))
          : msFromMs !== undefined
          ? Math.max(0, Math.floor(msFromMs))
          : seconds !== undefined
            ? Math.max(0, Math.floor(seconds * 1000))
            : 1000;
      if (sleepMs > 300_000) {
        throw new ToolInputError(`duration_ms ${sleepMs} exceeds maximum allowed sleep of 300000ms`);
      }
      await sleepTimeout(sleepMs);
      return jsonResult({ status: "ok", sleptMs: sleepMs });
    },
  };
}

export function createToolSearchCompatTool(): AnyAgentTool {
  return {
    name: "tool_search",
    label: "tool_search",
    description: "Compatibility bridge for claw-code ToolSearch tool.",
    parameters: Type.Object(
      {
        query: Type.String(),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true }).trim().toLowerCase();
      const limit = Math.max(
        1,
        Math.min(100, Math.floor(readNumberParam(params, "max_results") ?? readNumberParam(params, "limit") ?? 5)),
      );
      const entries = listCoreToolSections().flatMap((section) =>
        section.tools.map((tool) => ({
          id: tool.id,
          label: tool.label,
          description: tool.description,
          section: section.id,
        })),
      );
      const filtered = query
        ? entries.filter(
            (entry) =>
              entry.id.toLowerCase().includes(query) ||
              entry.label.toLowerCase().includes(query) ||
              entry.description.toLowerCase().includes(query),
          )
        : entries;
      return jsonResult({
        status: "ok",
        query,
        total: filtered.length,
        tools: filtered.slice(0, limit),
      });
    },
  };
}

export function createTodoWriteCompatTool(): AnyAgentTool {
  return {
    name: "todo_write",
    label: "todo_write",
    description: "Compatibility bridge for claw-code TodoWrite tool.",
    parameters: Type.Object(
      {
        text: Type.Optional(Type.String()),
        items: Type.Optional(Type.Array(Type.String())),
        todos: Type.Optional(Type.Array(Type.Unknown())),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const todosRaw = Array.isArray(params.todos) ? params.todos : [];
      if (todosRaw.length === 0) {
        throw new ToolInputError("todos must not be empty");
      }
      const normalizedTodos = todosRaw.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new ToolInputError("todo entries must be objects");
        }
        const todo = entry as Record<string, unknown>;
        const content = readStringParam(todo, "content", { required: true, label: "todo.content" });
        if (!content.trim()) {
          throw new ToolInputError("todo content must not be empty");
        }
        const activeForm = (readStringParam(todo, "activeForm") ?? readStringParam(todo, "active_form") ?? content).trim();
        if (!activeForm) {
          throw new ToolInputError("todo activeForm must not be empty");
        }
        const status = (readStringParam(todo, "status") ?? "pending").toLowerCase();
        return {
          content,
          activeForm,
          status,
          priority: readStringParam(todo, "priority") ?? null,
        };
      });

      const storePath = getTodoStorePath();
      let oldTodos: unknown[] = [];
      try {
        const raw = JSON.parse(await fs.readFile(storePath, "utf8"));
        if (Array.isArray(raw)) {
          oldTodos = raw;
        }
      } catch {
        oldTodos = [];
      }

      const allDone = normalizedTodos.every((todo) => todo.status === "completed");
      const persisted = allDone ? [] : normalizedTodos;
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(persisted, null, 2), "utf8");

      const verificationNudgeNeeded =
        allDone &&
        normalizedTodos.length >= 3 &&
        !normalizedTodos.some((todo) => todo.content.toLowerCase().includes("verif"));
      return jsonResult({
        old_todos: oldTodos,
        new_todos: normalizedTodos,
        verification_nudge_needed: verificationNudgeNeeded || undefined,
        store_path: storePath,
      });
    },
  };
}

export function createConfigCompatTool(): AnyAgentTool {
  return {
    name: "config_compat",
    label: "config_compat",
    description: "Compatibility bridge for claw-code Config tool.",
    parameters: Type.Object(
      {
        path: Type.Optional(Type.String()),
        setting: Type.Optional(Type.String()),
        value: Type.Optional(Type.Union([Type.String(), Type.Boolean(), Type.Number()])),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      const setting = readStringParam(params, "setting");
      if (setting) {
        const parsed = parseConfigPath(setting);
        if (!parsed.ok || !parsed.path) {
          return jsonResult({
            success: false,
            operation: null,
            setting,
            value: null,
            previous_value: null,
            new_value: null,
            error: parsed.error ?? `Unknown setting: "${setting}"`,
          });
        }

        if (params.value !== undefined) {
          const nextCfg = structuredClone(cfg);
          const previous = getConfigValueAtPath(nextCfg, parsed.path);
          setConfigValueAtPath(nextCfg, parsed.path, params.value);
          await writeConfigFile(nextCfg);
          return jsonResult({
            success: true,
            operation: "set",
            setting,
            value: params.value,
            previous_value: previous ?? null,
            new_value: params.value,
            error: null,
          });
        }

        return jsonResult({
          success: true,
          operation: "get",
          setting,
          value: getConfigValueAtPath(cfg, parsed.path) ?? null,
          previous_value: null,
          new_value: null,
          error: null,
        });
      }
      const path = readStringParam(params, "path");
      const value = path ? getByPath(cfg, path) : cfg;
      return jsonResult({
        status: "ok",
        path: path ?? null,
        value,
      });
    },
  };
}

export function createRemoteTriggerCompatTool(): AnyAgentTool {
  return {
    name: "remote_trigger",
    label: "remote_trigger",
    description: "Compatibility bridge for claw-code RemoteTrigger tool.",
    parameters: Type.Object(
      {
        url: Type.String(),
        method: Type.Optional(Type.String()),
        headers: Type.Optional(Type.Object({}, { additionalProperties: true })),
        body: Type.Optional(Type.Unknown()),
        timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 120000 })),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ToolInputError(`invalid url: ${url}`);
      }
      const method = (readStringParam(params, "method") ?? "GET").toUpperCase();
      const headersRecord = readRecordParam(params, "headers") ?? {};
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(headersRecord)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
      const timeoutMs = Math.max(100, Math.min(120000, Math.floor(readNumberParam(params, "timeoutMs") ?? 10000)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const bodyValue = params.body;
        const shouldSendBody = !["GET", "HEAD"].includes(method);
        const requestBody =
          shouldSendBody && bodyValue !== undefined
            ? typeof bodyValue === "string"
              ? bodyValue
              : JSON.stringify(bodyValue)
            : undefined;
        if (requestBody && !headers["content-type"]) {
          headers["content-type"] = "application/json";
        }
        const response = await fetch(parsed.toString(), {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });
        const text = await response.text();
        return jsonResult({
          status: response.ok ? "ok" : "failed",
          url: parsed.toString(),
          method,
          status_code: response.status,
          success: response.ok,
          httpStatus: response.status,
          ok: response.ok,
          body: text.slice(0, 8000),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createTestingPermissionCompatTool(): AnyAgentTool {
  return {
    name: "testing_permission",
    label: "testing_permission",
    description: "Compatibility bridge for claw-code TestingPermission tool.",
    parameters: Type.Object(
      {
        action: Type.Optional(Type.String()),
        allow: Type.Optional(Type.Boolean()),
        reason: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      const mode = normalizePermissionMode(getByPath(cfg, "permissions.defaultMode"));
      const action = readStringParam(params, "action") ?? "";
      const actionKind = classifyActionKind(action);
      const permitted =
        mode === "danger-full-access"
          ? true
          : mode === "workspace-write"
            ? actionKind !== "exec"
            : mode === "read-only" || mode === "plan"
              ? actionKind === "read" || actionKind === "unknown"
              : true;
      const allow = typeof params.allow === "boolean" ? params.allow : undefined;
      return jsonResult({
        action: action || null,
        permitted,
        mode,
        actionKind,
        message: permitted ? "Permission allowed by compatibility policy" : "Permission denied by compatibility policy",
        allow: allow ?? null,
        matchesExpected: allow === undefined ? null : allow === permitted,
        reason: readStringParam(params, "reason") ?? null,
      });
    },
  };
}
