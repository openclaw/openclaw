import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntimeImportGraph } from "../../scripts/lib/runtime-import-closure.mts";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const completionSelectionEntries = [
  "src/gateway/session-companion.ts",
  "src/gateway/session-companion-policy.ts",
  "src/agents/utility-completion.ts",
  "src/auto-reply/reply/conversation-label-generator.ts",
  "src/system-agent/setup-inference-detect.ts",
  "src/agents/simple-completion-selection.ts",
];
const passivePathEntries = [
  "src/infra/path-existence.ts",
  "src/agents/auth-profiles/shared-main-dir.ts",
  "src/state/openclaw-state-db.paths.ts",
];
const graph = createRuntimeImportGraph(
  repoRoot,
  [
    ...completionSelectionEntries,
    ...passivePathEntries,
    "src/gateway/call.ts",
    "src/gateway/config-get-response.ts",
    "src/gateway/method-scopes.ts",
    "src/gateway/server-cron.ts",
    "src/gateway/worker-environments/worker-exec-approval.ts",
    "src/gateway/server-close.runtime.ts",
    "src/gateway/server-methods/sessions-create.ts",
    "src/gateway/server-methods/chat-send-external-entry.ts",
    "src/gateway/worker-environments/local-workspace-prewarm.ts",
    "src/agents/embedded-agent-runner/run/attempt-setup.ts",
    "src/worker/inference-stream.runtime.ts",
    "src/agents/embedded-agent-runner/run/attempt.ts",
    "src/agents/embedded-agent-runner/run-orchestrator.ts",
    "src/process/spawn-broker/worker.ts",
    "src/agents/embedded-agent.runtime.ts",
    "src/auto-reply/reply/agent-runner-run.ts",
    "src/auto-reply/reply/session-updates.ts",
    "src/agents/command/attempt-execution.ts",
    "src/gateway/agent-turn/agent-turn-service.ts",
    "src/daemon/service-command.ts",
    "src/config/legacy-workboard-database.ts",
    "src/infra/sqlite-readonly-worker-context.ts",
    "src/infra/update-doctor-migration-context.ts",
    "src/infra/client-credential-store.ts",
    "src/infra/client-credential.worker.ts",
  ],
  { sourceImports: true },
);
afterAll(() => graph.close());

function collectStaticValueImports(entryRelativePath: string): string[] {
  const files = new Set([entryRelativePath]);
  for (const file of files) {
    for (const { resolvedFileName } of graph.dependencies(file)) {
      if (resolvedFileName) {
        const relative = path.relative(repoRoot, resolvedFileName);
        if (!relative.startsWith("..") && !relative.split(path.sep).includes("node_modules")) {
          files.add(relative);
        }
      }
    }
  }
  return [...files];
}

describe("gateway startup import boundaries", () => {
  it.each(passivePathEntries)(
    "resolves paths in %s without loading broader filesystem operations",
    (entry) => {
      const modules = collectStaticValueImports(entry);
      for (const deferred of [
        "src/infra/boundary-path.ts",
        "src/config/paths.ts",
        "src/utils.ts",
      ]) {
        expect(modules).not.toContain(path.normalize(deferred));
      }
      expect(
        modules.flatMap((file) => graph.dependencies(file).map(({ specifier }) => specifier)),
      ).not.toContain("@openclaw/fs-safe/advanced");
    },
  );

  it.each(completionSelectionEntries)(
    "selects models in %s without loading completion execution",
    (entry) => {
      const modules = collectStaticValueImports(entry);
      expect(modules).not.toContain(path.normalize("src/agents/simple-completion-runtime.ts"));
      expect(modules).not.toContain(path.normalize("src/agents/simple-completion-execution.ts"));
    },
  );

  it("resolves an explicit setup utility alias without loading completion execution", async () => {
    await withOpenClawTestState(
      { label: "setup-selection-cold-import", applyEnv: false },
      async (state) => {
        await state.writeConfig({
          agents: {
            defaults: {
              model: "fixture/primary",
              utilityModel: "fast@fixture:utility",
              models: { "fixture/utility": { alias: "fast" } },
            },
            entries: { main: {} },
          },
          models: {
            mode: "merge",
            providers: {
              fixture: {
                baseUrl: "http://127.0.0.1:9/v1",
                api: "openai-completions",
                models: [
                  { id: "primary", name: "Primary" },
                  { id: "utility", name: "Utility" },
                ],
              },
            },
          },
          plugins: { enabled: false },
          gateway: { mode: "local" },
        });
        const entry = new URL("../system-agent/setup-inference-detect.ts", import.meta.url).href;
        const result = await runNodeScript(
          [
            "--import",
            fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
            "--input-type=module",
            "--eval",
            `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (["runtime", "execution"].some((owner) =>
    [".ts", ".js"].some((extension) =>
      resolved.url.endsWith("/simple-completion-" + owner + extension)))) {
    throw new Error("Setup selection loaded completion execution");
  }
  return resolved;
}});
const { listManualSetupInferenceOptions } = await import(${JSON.stringify(entry)});
const result = await listManualSetupInferenceOptions("main");
console.log(JSON.stringify({ utilityModel: result.utilityModel, setupComplete: result.setupComplete }));
`,
          ],
          { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...state.envVars },
          30_000,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          utilityModel: "fixture/utility",
          setupComplete: true,
        });
      },
    );
  });

  it("skips unused sandbox prewarming without loading worktree execution", async () => {
    await withOpenClawTestState(
      { label: "prewarm-cold-import", applyEnv: false },
      async (state) => {
        const entry = new URL("./worker-environments/local-workspace-prewarm.ts", import.meta.url)
          .href;
        const result = await runNodeScript(
          [
            "--import",
            fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
            "--input-type=module",
            "--eval",
            `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if ([".ts", ".js"].some((extension) => resolved.url.endsWith("/worktrees/service" + extension))) {
    throw new Error("Unused prewarm loaded worktree execution");
  }
  return resolved;
}});
const { prewarmLocalWorkspaceTemplates } = await import(${JSON.stringify(entry)});
const config = { gateway: { controlUi: { enabled: false } }, agents: { defaults: { sandbox: { mode: "off" } } } };
await prewarmLocalWorkspaceTemplates({
  getConfig: () => config,
  signal: new AbortController().signal,
});
console.log("prewarm-cold-selection-ok");`,
          ],
          { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...state.envVars },
          30_000,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("prewarm-cold-selection-ok");
      },
    );
  });

  it.each([
    ["src/gateway/call.ts", "src/gateway/method-scopes.ts"],
    ["src/gateway/call.ts", "src/infra/worker-task-pool.ts"],
    ["src/gateway/call.ts", "src/infra/client-credential-store.ts"],
    ["src/infra/client-credential.worker.ts", "src/infra/exec-approvals-config.ts"],
    ["src/infra/client-credential-native-bootstrap.ts", "src/infra/exec-approvals-config.ts"],
    ["src/gateway/config-get-response.ts", "src/config/runtime-schema.ts"],
    ["src/daemon/service-command.ts", "src/daemon/launchd-runtime.ts"],
    ["src/daemon/service-command.ts", "src/daemon/schtasks-layout.ts"],
    ["src/config/legacy-workboard-database.ts", "src/infra/database-engine/open.ts"],
  ])("loads %s without the demand-only %s", (entry, deferred) => {
    expect(collectStaticValueImports(entry)).not.toContain(path.normalize(deferred));
  });

  it.each([
    "src/infra/sqlite-readonly-worker-context.ts",
    "src/infra/update-doctor-migration-context.ts",
    "src/infra/client-credential-store.ts",
    "src/infra/client-credential.worker.ts",
  ])("reads cancellation in %s without loading SQLite workers", (entry) => {
    const modules = collectStaticValueImports(entry);
    expect(modules).not.toContain(path.normalize("src/infra/sqlite-readonly-worker.ts"));
    expect(modules).not.toContain(path.normalize("src/infra/sqlite-readonly-worker-pool.ts"));
  });

  it("prepares worker exec approvals without loading model completion", () => {
    expect(
      collectStaticValueImports("src/gateway/worker-environments/worker-exec-approval.ts"),
    ).not.toContain(path.normalize("src/agents/simple-completion-runtime.ts"));
  });

  it("starts cron without loading agent turn execution", () => {
    const modules = collectStaticValueImports("src/gateway/server-cron.ts");
    expect(modules).not.toContain(path.normalize("src/cron/isolated-agent/run.ts"));
    expect(modules).not.toContain(path.normalize("src/agents/embedded-agent-runner/run.ts"));
  });

  it("prepares Gateway turns without local command or broad session runtimes", () => {
    const modules = collectStaticValueImports("src/gateway/agent-turn/agent-turn-service.ts");
    expect(modules).not.toContain(path.normalize("src/agents/agent-command-local.ts"));
    expect(modules).not.toContain(path.normalize("src/agents/sessions/index.ts"));
  });

  it.each([
    "src/agents/embedded-agent-runner/run/attempt.ts",
    "src/agents/embedded-agent-runner/run-orchestrator.ts",
    "src/agents/embedded-agent.runtime.ts",
    "src/auto-reply/reply/agent-runner-run.ts",
    "src/auto-reply/reply/session-updates.ts",
    "src/agents/command/attempt-execution.ts",
  ])("prepares %s without loading sandbox execution", (entry) => {
    expect(collectStaticValueImports(entry)).not.toContain(
      path.normalize("src/agents/sandbox/context.ts"),
    );
  });

  it("starts the command broker without loading the execa runtime", () => {
    expect(collectStaticValueImports("src/process/spawn-broker/worker.ts")).not.toContain(
      path.normalize("src/process/spawn-broker/execa-worker.ts"),
    );
  });

  it.each([
    "src/agents/embedded-agent-runner/run/attempt-setup.ts",
    "src/worker/inference-stream.runtime.ts",
  ])("prepares %s without loading the computer tool runtime", (entry) => {
    expect(collectStaticValueImports(entry)).not.toContain(
      path.normalize("src/agents/tools/computer-tool.ts"),
    );
  });

  it("keeps sandbox workspace preparation out of the prewarm selection graph", () => {
    const modules = collectStaticValueImports(
      "src/gateway/worker-environments/local-workspace-prewarm.ts",
    );
    for (const file of [
      "src/agents/worktrees/allocation.ts",
      "src/agents/worktrees/base-ref.ts",
      "src/agents/worktrees/repository-paths.ts",
      "src/agents/worktrees/run-end-lifecycle.ts",
      "src/agents/worktrees/service-preparation.ts",
      "src/gateway/worker-environments/local-workspace-template.ts",
    ]) {
      expect(modules).not.toContain(path.normalize(file));
    }
  });

  it("prepares chat.send without loading the media execution runtime", () => {
    expect(
      collectStaticValueImports("src/gateway/server-methods/chat-send-external-entry.ts"),
    ).not.toContain("src/media-understanding/runtime.ts");
  });

  it("keeps static method policy independent of session storage", () => {
    const modules = collectStaticValueImports("src/gateway/method-scopes.ts");
    expect(
      modules.filter((file) => file.startsWith(path.join("src", "config", "sessions") + path.sep)),
    ).toEqual([]);
  });

  it("keeps ordinary session lifecycle code out of the prepared shutdown graph", () => {
    expect(collectStaticValueImports("src/gateway/server-close.runtime.ts")).not.toContain(
      "src/gateway/session-reset-service.ts",
    );
  });

  it("keeps agent execution out of the session creation import graph", () => {
    const modules = collectStaticValueImports("src/gateway/server-methods/sessions-create.ts");

    expect(modules).not.toContain("src/gateway/server-methods/chat-send-external-entry.ts");
    expect(modules).not.toContain("src/gateway/server-methods/chat-send-handler.ts");
    expect(modules).not.toContain("src/agents/embedded-agent-runner/run.ts");
    expect(modules).not.toContain("src/agents/embedded-agent-runner/compact.queued.ts");
  });
});
