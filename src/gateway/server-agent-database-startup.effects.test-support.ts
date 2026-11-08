import fs from "node:fs";
import path from "node:path";
import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { runHostPreparedIsolatedCompletion } from "../agents/host-prepared-isolated-completion.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { completeWithPreparedSimpleCompletionModel } from "../agents/simple-completion-execution.js";
import {
  acquireSimpleCompletionModelForAgent,
  prepareSimpleCompletionModel,
} from "../agents/simple-completion-runtime.js";
import * as simpleCompletion from "../agents/simple-completion-runtime.js";
import { assertPrepared, completionContext } from "../agents/simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { anthropicAnalyzePdf } from "../agents/tools/pdf-native-providers.js";
import { createPdfTool } from "../agents/tools/pdf-tool.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { bindModelLlmRuntime, getModelCompletionTransport } from "../llm/model-runtime-binding.js";
import { completeSimple } from "../llm/stream.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import * as pdfExtract from "../media/pdf-extract.js";
import * as webMedia from "../media/web-media.js";
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
      const pdfWaits = new Map<
        string,
        {
          ready: ReturnType<typeof createDeferred<void>>;
          resume: ReturnType<typeof createDeferred<void>>;
        }
      >();
      const runtimes = new Map<string, ReturnType<typeof createLlmRuntime>>();
      const prepare = simpleCompletion.prepareSimpleCompletionModel;
      vi.spyOn(simpleCompletion, "prepareSimpleCompletionModel").mockImplementation(
        async (...args) => {
          const prepared = await prepare(...args);
          const runtime = args[0].agentId && runtimes.get(args[0].agentId);
          return runtime && "model" in prepared
            ? {
                ...prepared,
                model: bindModelLlmRuntime(
                  prepared.model,
                  runtime,
                  getModelCompletionTransport(prepared.model),
                ),
              }
            : prepared;
        },
      );
      vi.spyOn(pdfExtract, "extractPdfContent").mockImplementation(async (params) => {
        const agent = agentIds.find((id) => params.buffer.toString() === `%PDF-${id}`);
        const held = agent && pdfWaits.get(agent);
        if (held) {
          held.ready.resolve();
          await held.resume.promise;
        }
        return { text: "Synthetic extracted PDF text", images: [] };
      });
      vi.spyOn(webMedia, "loadWebMediaRaw").mockImplementation(async (input) => ({
        kind: "document",
        contentType: "application/pdf",
        fileName: path.basename(input),
        buffer: Buffer.from(`%PDF-${path.basename(input, ".pdf")}`),
      }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          const agent = new Headers(init?.headers).get("x-handoff-agent");
          if (!agent) {
            throw new Error("Native PDF fixture lost its agent");
          }
          providerCalls.push(agent);
          return Response.json({ content: [{ type: "text", text: "Stubbed PDF completed" }] });
        }),
      );
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
        const runtime = createLlmRuntime(registry);
        runtimes.set(agentId, runtime);
        const model = bindModelLlmRuntime(
          acquired.model,
          runtime,
          getModelCompletionTransport(acquired.model),
        );
        const lease = resources.use(
          await acquireAgentRunPreparedModelRuntime({
            config: cfg,
            agentId,
            agentDir: acquired.selection.agentDir,
            workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
          }),
        );
        const prepared = await prepareSimpleCompletionModel({
          cfg,
          agentId,
          provider: "anthropic",
          modelId: "claude-opus-4-6",
          profileId: "anthropic:fleet",
          bindAuthOwner: true,
          preparedModelRuntime: lease.snapshot,
        });
        assertPrepared(prepared);
        const lowerModel = bindModelLlmRuntime(
          prepared.model,
          runtime,
          getModelCompletionTransport(prepared.model),
        );
        const held = { ready: createDeferred(), resume: createDeferred() };
        pdfWaits.set(agentId, held);
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const pdfTool = createPdfTool({
          config: cfg,
          agentId,
          agentDir: lease.snapshot.agentDir,
          workspaceDir,
          preparedModelRuntime: lease.snapshot,
        });
        if (!pdfTool) {
          throw new Error("Expected the configured PDF tool");
        }
        const pendingPdf = pdfTool.execute(`retained-pdf-${agentId}`, {
          pdf: path.join(workspaceDir, `${agentId}.pdf`),
        });
        void pendingPdf.catch(held.ready.reject);
        resources.defer(async () => {
          held.resume.resolve();
          await Promise.allSettled([pendingPdf]);
        });
        await held.ready.promise;
        return {
          session: await SessionManager.openAsync(target(agentId)),
          auth: acquired.auth,
          pdfTool: async () => {
            held.resume.resolve();
            return await pendingPdf;
          },
          directComplete: () =>
            completeSimple(lowerModel, completionContext("Direct facade"), {
              apiKey: prepared.auth.apiKey,
            }),
          isolated: () =>
            runHostPreparedIsolatedCompletion({
              authorization: { owner: "host", model: lowerModel, auth: prepared.auth },
              config: cfg,
              agentId,
              agentDir: lease.snapshot.agentDir,
              workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
              provider: lowerModel.provider,
              modelId: lowerModel.id,
              systemPrompt: "Synthetic isolated request",
              prompt: "Retained isolated request",
              timeoutMs: 10_000,
            }),
          nativePdf: () =>
            anthropicAnalyzePdf({
              model: lowerModel,
              apiKey: prepared.auth.apiKey!,
              modelId: lowerModel.id,
              prompt: "Retained native PDF",
              pdfs: [{ base64: Buffer.from("%PDF-fixture").toString("base64") }],
              baseUrl: "http://127.0.0.1:43991/v1",
              requestConfig: {
                headers: { "x-handoff-agent": agentId },
                request: { allowPrivateNetwork: true },
              },
            }),
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
