import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntimeImportGraph } from "../../scripts/lib/runtime-import-closure.mts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const graph = createRuntimeImportGraph(
  repoRoot,
  [
    "src/gateway/method-scopes.ts",
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
