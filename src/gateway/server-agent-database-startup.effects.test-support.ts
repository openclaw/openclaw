import fs from "node:fs";
import path from "node:path";
import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { completeWithPreparedSimpleCompletionModel } from "../agents/simple-completion-execution.js";
import { acquireSimpleCompletionModelForAgent } from "../agents/simple-completion-runtime.js";
import { assertPrepared, completionContext } from "../agents/simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { bindModelLlmRuntime, getModelCompletionTransport } from "../llm/model-runtime-binding.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";

/** Observe native SQL per agent store, including workers retained across refusal. */
export async function prepareHandoffEffectProbe(agentIds: string[], env: NodeJS.ProcessEnv) {
  const root = resolveStateDir(env);
  const armed = path.join(root, "handoff-effects-armed");
  const trace = path.join(root, "handoff-effects-sql");
  const preload = path.join(root, "handoff-effects.cjs");
  const targets = Object.fromEntries(
    agentIds.map((agentId) => [resolveOpenClawAgentSqlitePath({ agentId, env }), agentId]),
  );
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(trace, "");
  // No bindings, SQL, credentials, or message contents leave the native observer.
  fs.writeFileSync(
    preload,
    `
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const targets = ${JSON.stringify(targets)};
const record = (db, sql) => {
  const agent = targets[db.location()];
  if (agent && fs.existsSync(${JSON.stringify(armed)})) {
    const access = /^\\s*(insert|update|delete|replace|create|drop|alter)\\b/i.test(sql) ? 'write' : 'read';
    fs.appendFileSync(${JSON.stringify(trace)}, agent + ':' + access + '\\n');
  }
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  record(this, sql);
  return Reflect.apply(exec, this, arguments);
};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const db = this;
  const statement = Reflect.apply(prepare, db, arguments);
  for (const method of ['get', 'all', 'run', 'iterate']) {
    const execute = statement[method];
    statement[method] = function() {
      record(db, sql);
      return Reflect.apply(execute, this, arguments);
    };
  }
  return statement;
};
`,
  );
  const preloadEnv = sqliteWorkerPreloadEnv(preload);
  Object.assign(env, preloadEnv);
  for (const [key, value] of Object.entries(preloadEnv)) {
    vi.stubEnv(key, value);
  }
  const target = (agentId: string) => ({
    agentId,
    env,
    storePath: resolveOpenClawAgentSqlitePath({ agentId, env }),
    sessionId: `handoff-${agentId}`,
    sessionKey: `agent:${agentId}:handoff`,
  });
  for (const agentId of agentIds) {
    const scope = target(agentId);
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const session = await SessionManager.openAsync(scope);
    await session.appendMessageAsync({ role: "user", content: "Before refusal", timestamp: 1 });
  }
  return {
    async capture(firstAgent: string) {
      await using resources = new AsyncDisposableStack();
      const providerCalls: string[] = [];
      const capture = async (agentId: string) => {
        const cfg = getRuntimeConfig();
        const acquired = await acquireSimpleCompletionModelForAgent({
          cfg,
          agentId,
          modelRef: "anthropic/claude-opus-4-6@anthropic:fleet",
          bindAuthOwner: true,
        });
        assertPrepared(acquired);
        resources.use(acquired);
        const registry = createApiRegistry();
        const providerStream = () => {
          providerCalls.push(agentId);
          const output = createAssistantMessageEventStream();
          const message = makeAgentAssistantMessage({
            api: acquired.model.api,
            provider: acquired.model.provider,
            model: acquired.model.id,
            content: [{ type: "text", text: "Stubbed provider completed" }],
          });
          output.push({ type: "done", reason: "stop", message });
          output.end();
          return output;
        };
        registry.registerApiProvider({
          api: acquired.model.api,
          stream: providerStream,
          streamSimple: providerStream,
        });
        // Replace only external transport; preserve the real retained completion owner.
        const model = bindModelLlmRuntime(
          acquired.model,
          createLlmRuntime(registry),
          getModelCompletionTransport(acquired.model),
        );
        return {
          session: await SessionManager.openAsync(target(agentId)),
          auth: acquired.auth,
          complete: () =>
            completeWithPreparedSimpleCompletionModel({
              cfg,
              model,
              auth: acquired.auth,
              context: completionContext("After cleanup refusal"),
            }),
        };
      };
      const first = await capture(firstAgent);
      const sibling = await capture(agentIds.find((agentId) => agentId !== firstAgent)!);
      const owned = resources.move();
      return {
        first,
        sibling,
        providerCalls,
        arm: () => {
          fs.writeFileSync(trace, "");
          fs.writeFileSync(armed, "");
        },
        sql: () => fs.readFileSync(trace, "utf8").split("\n").filter(Boolean),
        [Symbol.asyncDispose]: () => owned.disposeAsync(),
      };
    },
  };
}
