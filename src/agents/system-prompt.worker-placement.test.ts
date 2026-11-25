import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

type PromptParams = Parameters<typeof buildAgentSystemPrompt>[0];

function renderPrompt(params: Partial<PromptParams> = {}) {
  return buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", ...params });
}

function renderLocalAndWorker(params: Partial<PromptParams>) {
  return {
    local: renderPrompt(params),
    worker: renderPrompt({ ...params, workerPlacement: true }),
  };
}

describe("buildAgentSystemPrompt with worker-placed session tools", () => {
  it("describes the worker sessions_spawn arguments", () => {
    const { local, worker } = renderLocalAndWorker({ toolNames: ["sessions_spawn"] });
    expect(local).toContain('`context:"isolated"`');
    expect(worker).toContain("delegate bounded independent work via `sessions_spawn`");
    expect(worker).toContain("the whole child brief goes in `task`");
    for (const fullToolOnly of ["objective/output", "`context:", "`taskName`"]) {
      expect(worker).not.toContain(fullToolOnly);
    }
  });

  it("describes worker delegation as visible children briefed through task", () => {
    const { local, worker } = renderLocalAndWorker({
      toolNames: ["sessions_spawn"],
      subagentDelegationMode: "prefer",
    });
    expect(local).toContain("`visible=true`");
    expect(local).toContain("brief each child with objective, output, write scope, verification");
    expect(worker).toContain("## Delegation");
    expect(worker).toContain("every child is a visible session in the user's sidebar");
    expect(worker).toContain("(objective, output, write scope, verification) goes in `task`");
    expect(worker).not.toContain("visible=true");
    expect(worker).not.toContain("Use subagents for internal QA");
  });

  it("does not promise hidden children in worker session routing", () => {
    const { local, worker } = renderLocalAndWorker({
      toolNames: ["sessions_spawn", "sessions_create"],
    });
    expect(local).toContain("use hidden children by default");
    expect(worker).toContain("## Session routing");
    expect(worker).toContain("`sessions_spawn` children are always visible sessions");
    expect(worker).not.toContain("hidden children");
  });

  it("omits ACP spawn guidance on a worker", () => {
    const { local, worker } = renderLocalAndWorker({
      toolNames: ["sessions_spawn"],
      acpEnabled: true,
      runtimeInfo: { capabilities: ["threadbound-acp-spawn"] },
    });
    expect(local).toContain('`sessions_spawn(runtime:"acp")`');
    expect(local).toContain("thread:true");
    for (const acpOnly of ['runtime:"acp"', "thread:true", 'mode:"run"']) {
      expect(worker).not.toContain(acpOnly);
    }
  });
});
