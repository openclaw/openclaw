// Blind child prompts: the renderer withholds the child's route and workspace, nothing else.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildCliAgentSystemPrompt } from "./cli-runner/helpers.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

async function aliasedWorkspace() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "blind-prompt-")));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, "agent-workspace-k4");
  await fs.mkdir(real);
  const alias = path.join(root, "alias-k4");
  await fs.symlink(real, alias);
  return { real, alias };
}

const runtimeInfo = (workspace: string, blind?: boolean) => ({
  agentId: "relay-check",
  agentName: "Relay",
  sessionKey: "agent:relay-check:subagent:5b1c",
  sessionId: "session-5b1c",
  host: "host-a",
  os: "macOS 27",
  arch: "arm64",
  node: "v26.12.1",
  shell: "zsh",
  model: "vendor-x/trial-model-7",
  defaultModel: "vendor-y/default-model-3",
  repoRoot: workspace,
  blind,
});

describe("blind system prompt", () => {
  it("withholds model, agent, session and every workspace spelling, keeping environment facts", async () => {
    const { real, alias } = await aliasedWorkspace();
    const render = (blind: boolean) =>
      buildAgentSystemPrompt({
        // The configured spelling is a symlink; bootstrap files report the resolved path.
        workspaceDir: alias,
        runtimeInfo: runtimeInfo(alias, blind),
        contextFiles: [{ path: path.join(real, "AGENTS.md"), content: "Use the house style." }],
        workspaceNotes: [`Notes live in ${alias}/notes.`],
      });

    const ordinary = render(false);
    for (const fact of [
      "Current model identity: vendor-x/trial-model-7",
      "model=vendor-x/trial-model-7",
      "default_model=vendor-y/default-model-3",
      "agent=relay-check",
      "name=Relay",
      "session=agent:relay-check:subagent:5b1c",
      `repo=${alias}`,
      `Working directory: ${alias}`,
      path.join(real, "AGENTS.md"),
    ]) {
      expect(ordinary).toContain(fact);
    }
    expect(ordinary).not.toContain("<workspace>");

    const blind = render(true);
    for (const withheld of [
      "trial-model-7",
      "default-model-3",
      "Current model identity",
      "relay-check",
      "Relay",
      "5b1c",
      "repo=",
      real,
      alias,
    ]) {
      expect(blind, withheld).not.toContain(withheld);
    }
    expect(blind).toContain(
      "Working directory: <workspace>\n<workspace> stands for a withheld path; use paths relative to the working directory.",
    );
    expect(blind).toContain("## <workspace>/AGENTS.md");
    expect(blind).toContain("Use the house style.");
    expect(blind).toContain("Notes live in <workspace>/notes.");
    expect(blind).toContain(
      "Runtime: host=host-a | os=macOS 27 (arm64) | node=v26.12.1 | shell=zsh",
    );
  });

  it("replaces only the workspace path itself, not paths that share its text", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/srv/agents/ws",
      workspaceNotes: [
        "Archive: /srv/agents/ws-old/a and /mirror/srv/agents/ws/b; data: /srv/agents/ws/c.",
      ],
      runtimeInfo: { blind: true },
    });
    expect(prompt).toContain(
      "Archive: /srv/agents/ws-old/a and /mirror/srv/agents/ws/b; data: <workspace>/c.",
    );
    expect(prompt).toContain("Working directory: <workspace>");
  });

  it("keeps an ordinary prompt byte-identical when blind is omitted or false", () => {
    const render = (blind?: boolean) =>
      buildAgentSystemPrompt({
        workspaceDir: "/srv/agents/ws",
        runtimeInfo: runtimeInfo("/srv/agents/ws", blind),
      });
    expect(render(false)).toBe(render());
  });

  it("blinds the CLI backend prompt from the child's stored session entry", async () => {
    const { real } = await aliasedWorkspace();
    const render = (blindPrompt?: true) =>
      buildCliAgentSystemPrompt({
        workspaceDir: real,
        tools: [],
        modelDisplay: "claude-cli/trial-model-7",
        agentId: "relay-check",
        sessionKey: "agent:relay-check:subagent:5b1c",
        preparedSessionEntry: { sessionId: "session-5b1c", updatedAt: 1, blindPrompt },
      });
    const ordinary = render();
    expect(ordinary).toContain("model=claude-cli/trial-model-7");
    expect(ordinary).toContain("session=agent:relay-check:subagent:5b1c");
    expect(ordinary).toContain(real);
    const blind = render(true);
    for (const withheld of ["trial-model-7", "default_model=", "relay-check", "5b1c", real]) {
      expect(blind, withheld).not.toContain(withheld);
    }
  });
});
