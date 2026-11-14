// Scripted transport only: all automation writes and shell effects belong to Gateway.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
} from "../../../../scripts/e2e/lib/codex-app-server-fixture.mjs";

const planPath = process.env.OPENCLAW_QA_SCHEDULED_SHELL_PLAN;
const logPath = process.env.OPENCLAW_QA_SCHEDULED_SHELL_LOG;
const version = process.env.OPENCLAW_QA_CODEX_APP_SERVER_VERSION;
if (!planPath || !logPath || !version) {
  throw new Error("missing scheduled-shell fixture environment");
}
const threads = new Map();
const pending = new Map();
function log(message) {
  fs.appendFileSync(logPath, `${JSON.stringify(message)}\n`);
}
function emit(message) {
  log({ direction: "out", ...message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function result(id, value) {
  emit({ id, result: value });
}
function complete(threadId, turnId) {
  const now = Date.now();
  const message = { type: "agentMessage", id: randomUUID(), text: "SCHEDULED_SHELL_FIXTURE_DONE" };
  emit({
    method: "item/completed",
    params: { threadId, turnId, item: message, completedAtMs: now },
  });
  emit({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [message],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: Math.floor(now / 1000),
        completedAt: Math.floor(now / 1000),
        durationMs: 0,
      },
    },
  });
}
function functions(specs) {
  return (specs ?? []).flatMap((spec) =>
    spec.type === "namespace"
      ? spec.tools.map((tool) => ({ ...tool, namespace: spec.name }))
      : [{ ...spec, namespace: null }],
  );
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  log({ direction: "in", ...message });
  if (message.method === undefined && pending.has(message.id)) {
    const turn = pending.get(message.id);
    pending.delete(message.id);
    complete(turn.threadId, turn.turnId);
    return;
  }
  if (message.id === undefined || typeof message.method !== "string") {
    return;
  }
  const { id, params } = message;
  switch (message.method) {
    case "initialize":
      result(
        id,
        createFakeInitializeResponse({
          name: "qa-scheduled-shell",
          version,
          userAgent: `openclaw/${version} (test)`,
        }),
      );
      return;
    case "account/login/start":
      result(id, { type: params?.type });
      return;
    case "model/list":
      result(id, {
        data: [
          {
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "gpt-5.6-luna",
            description: "Synthetic scheduled-shell proof",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
            multiAgentVersion: "v2",
            inputModalities: ["text"],
          },
        ],
        nextCursor: null,
      });
      return;
    case "account/read":
      result(id, {
        account: { type: "chatgpt", email: "qa-scheduled-shell@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      });
      return;
    case "account/rateLimits/read":
      result(id, {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
      });
      return;
    case "config/read":
      result(id, { config: {}, origins: {}, layers: [] });
      return;
    case "configRequirements/read":
      result(id, { requirements: null });
      return;
    case "mcpServerStatus/list":
      result(id, { data: [], nextCursor: null });
      return;
    case "thread/start":
    case "thread/resume": {
      const threadId = params?.threadId ?? randomUUID();
      threads.set(threadId, functions(params?.dynamicTools));
      result(
        id,
        createFakeThreadStartResponse({ params, threadId, sessionId: randomUUID(), version }),
      );
      return;
    }
    case "turn/start": {
      const threadId = params.threadId;
      const turnId = randomUUID();
      result(id, {
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      setImmediate(() => {
        const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
        // Claim one scripted operation per occurrence, including across app-server restarts.
        // Follow-up turns must not repeat commands or manufacture another approval.
        try {
          fs.closeSync(fs.openSync(`${planPath}.${plan.id}.claimed`, "wx", 0o600));
        } catch (error) {
          if (error.code !== "EEXIST") {
            throw error;
          }
          complete(threadId, turnId);
          return;
        }
        const catalog = threads.get(threadId) ?? [];
        const tool = catalog.find((item) =>
          plan.phase === "create"
            ? ["automations", "cron"].includes(item.name)
            : ["gateway_exec", "exec"].includes(item.name),
        );
        if (!tool) {
          throw new Error(
            `missing ${plan.phase} tool: ${catalog.map((item) => item.name).join(",")}`,
          );
        }
        const requestId = `scheduled-shell-${randomUUID()}`;
        pending.set(requestId, { threadId, turnId });
        emit({
          id: requestId,
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: requestId,
            namespace: tool.namespace,
            tool: tool.name,
            arguments: plan.phase === "create" ? { action: "add", job: plan.job } : plan.arguments,
          },
        });
      });
      return;
    }
    default:
      result(id, {});
  }
});
