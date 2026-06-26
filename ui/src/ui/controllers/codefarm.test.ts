// Control UI tests cover Code Farm controller behavior.
import { describe, expect, it, vi } from "vitest";
import {
  archiveCodefarmProject,
  configureCodefarmProject,
  getCodefarmState,
  loadCodefarmJobs,
  loadCodefarmProject,
  loadCodefarmRepos,
  observeCodefarmJob,
  selectCodefarmRepo,
  sendCodefarmProjectTerminalInput,
  setCodefarmProjectRuntime,
} from "./codefarm.ts";

function createClient(responses: Record<string, unknown>) {
  const request = vi.fn(async (method: string, _params: unknown) => responses[method]);
  return { request };
}

describe("codefarm controller", () => {
  it("loads active and recent repos through the first-class Code Farm gateway method", async () => {
    const host = {};
    const client = createClient({
      "codefarm.repos": {
        repos: [
          {
            repo: "/Users/me/agent-space",
            name: "agent-space",
            totalJobs: 2,
            activeJobs: 1,
            reviewJobs: 1,
            blockedJobs: 0,
            latestUpdatedAt: "2026-06-25T12:00:00.000Z",
            statuses: { running: 1, ready_for_review: 1 },
          },
        ],
      },
      "codefarm.project": {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        contextFiles: [],
        gsd: { available: false, files: [] },
      },
      "codefarm.list": {
        jobs: [{ id: "cf_20260625_001", status: "running" }],
      },
    });

    await loadCodefarmRepos({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("codefarm.repos", {});
    expect(client.request).toHaveBeenCalledWith("codefarm.project", {
      repo: "/Users/me/agent-space",
    });
    expect(client.request).toHaveBeenCalledWith("codefarm.list", {
      repo: "/Users/me/agent-space",
    });
    expect(getCodefarmState(host).repos).toEqual([
      expect.objectContaining({
        repo: "/Users/me/agent-space",
        activeJobs: 1,
        totalJobs: 2,
      }),
    ]);
    expect(getCodefarmState(host).selectedRepo).toBe("/Users/me/agent-space");
    expect(getCodefarmState(host).jobs).toEqual([
      expect.objectContaining({ id: "cf_20260625_001" }),
    ]);
  });

  it("can include archived repos in discovery", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.showArchived = true;
    const client = createClient({
      "codefarm.repos": {
        repos: [
          {
            repo: "/Users/me/old-project",
            name: "old-project",
            status: "archived",
            archived: true,
            archivedAt: "2026-06-25T14:00:00.000Z",
            totalJobs: 1,
            activeJobs: 0,
            reviewJobs: 1,
            blockedJobs: 0,
            statuses: { ready_for_review: 1 },
          },
        ],
      },
      "codefarm.project": {
        repo: "/Users/me/old-project",
        name: "old-project",
        archived: true,
        contextFiles: [],
        gsd: { available: false, files: [] },
      },
      "codefarm.list": { jobs: [] },
    });

    await loadCodefarmRepos({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("codefarm.repos", { includeArchived: true });
    expect(state.repos).toEqual([
      expect.objectContaining({ repo: "/Users/me/old-project", archived: true }),
    ]);
  });

  it("archives and unarchives the selected project through write gateway methods", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.selectedRepo = "/Users/me/agent-space";
    state.project = {
      repo: "/Users/me/agent-space",
      name: "agent-space",
      status: "active",
      archived: false,
      jobs: { totalJobs: 1, activeJobs: 0, statuses: { ready_for_review: 1 } },
      contextFiles: [],
      gsd: { available: false, files: [] },
    };
    const client = createClient({
      "codefarm.project.archive": {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        status: "archived",
        archived: true,
        archivedAt: "2026-06-25T14:00:00.000Z",
        jobs: { totalJobs: 1, activeJobs: 0, statuses: { ready_for_review: 1 } },
        contextFiles: [],
        gsd: { available: false, files: [] },
      },
      "codefarm.project.unarchive": {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        status: "active",
        archived: false,
        jobs: { totalJobs: 1, activeJobs: 0, statuses: { ready_for_review: 1 } },
        contextFiles: [],
        gsd: { available: false, files: [] },
      },
    });

    await archiveCodefarmProject({
      host,
      client: client as never,
      repo: "/Users/me/agent-space",
      archived: true,
    });

    expect(client.request).toHaveBeenCalledWith("codefarm.project.archive", {
      repo: "/Users/me/agent-space",
    });
    expect(state.project).toEqual(expect.objectContaining({ archived: true }));

    await archiveCodefarmProject({
      host,
      client: client as never,
      repo: "/Users/me/agent-space",
      archived: false,
    });

    expect(client.request).toHaveBeenCalledWith("codefarm.project.unarchive", {
      repo: "/Users/me/agent-space",
    });
    expect(state.project).toEqual(expect.objectContaining({ archived: false }));
  });

  it("configures project context through the Project Foreman gateway method", async () => {
    const host = {};
    const state = getCodefarmState(host);
    const client = createClient({
      "codefarm.project.configure": {
        repo: "/Users/me/agent-space",
        name: "Agent Space",
        jobs: { totalJobs: 0, activeJobs: 0, statuses: {} },
        contextFiles: [
          {
            path: ".codefarm/PROJECT.md",
            title: "PROJECT.md",
            kind: "project_doc",
            content: "Mission: Make Code Farm observable.",
            truncated: false,
          },
        ],
        gsd: {
          available: true,
          files: [
            {
              path: ".gsd/STATE.md",
              title: "STATE.md",
              kind: "gsd_state",
              content: "Milestone: Persistent project terminals",
              truncated: false,
            },
          ],
        },
        projectForm: {
          projectName: "Agent Space",
          mission: "Make Code Farm observable.",
          currentMilestone: "Persistent project terminals",
          currentSlice: "Project Foreman profile and form",
        },
        profile: {
          id: "project-foreman",
          name: "Project Foreman",
          status: "configured",
          workspace: "/Users/me/.openclaw/workspaces/project-foreman",
          agentDir: "/Users/me/.openclaw/agents/project-foreman/agent",
          contract: ["GSD-first", "CodeFarm execution", "Persistent tmux"],
        },
      },
    });

    await configureCodefarmProject({
      host,
      client: client as never,
      repo: "/Users/me/agent-space",
      form: {
        projectName: "Agent Space",
        mission: "Make Code Farm observable.",
        currentMilestone: "Persistent project terminals",
        currentSlice: "Project Foreman profile and form",
      },
    });

    expect(client.request).toHaveBeenCalledWith("codefarm.project.configure", {
      repo: "/Users/me/agent-space",
      form: {
        projectName: "Agent Space",
        mission: "Make Code Farm observable.",
        currentMilestone: "Persistent project terminals",
        currentSlice: "Project Foreman profile and form",
      },
    });
    expect(state.projectFormSaving).toBe(false);
    expect(state.projectForm).toMatchObject({
      mission: "Make Code Farm observable.",
      currentMilestone: "Persistent project terminals",
    });
    expect(state.project).toEqual(
      expect.objectContaining({
        profile: expect.objectContaining({ name: "Project Foreman", status: "configured" }),
      }),
    );
  });

  it("sets the selected project runtime through a write gateway method", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.selectedRepo = "/Users/me/agent-space";
    state.project = {
      repo: "/Users/me/agent-space",
      name: "Agent Space",
      jobs: { totalJobs: 0, activeJobs: 0, statuses: {} },
      contextFiles: [],
      gsd: { available: false, files: [] },
      runtime: {
        selected: "codex-cli",
        options: [
          { id: "codex-cli", label: "Codex CLI" },
          { id: "claude-code", label: "Claude Code" },
        ],
      },
    };
    const client = createClient({
      "codefarm.project.runtime.set": {
        repo: "/Users/me/agent-space",
        name: "Agent Space",
        jobs: { totalJobs: 0, activeJobs: 0, statuses: {} },
        contextFiles: [],
        gsd: { available: false, files: [] },
        runtime: {
          selected: "claude-code",
          options: [
            { id: "codex-cli", label: "Codex CLI" },
            { id: "claude-code", label: "Claude Code" },
          ],
        },
      },
    });

    await setCodefarmProjectRuntime({
      host,
      client: client as never,
      repo: "/Users/me/agent-space",
      runtime: "claude-code",
    });

    expect(client.request).toHaveBeenCalledWith("codefarm.project.runtime.set", {
      repo: "/Users/me/agent-space",
      runtime: "claude-code",
    });
    expect(state.runtimeSaving).toBe(false);
    expect(state.project).toEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({ selected: "claude-code" }),
      }),
    );
  });

  it("selects a repo and loads its jobs without requiring a manual path", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.repos = [
      {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        totalJobs: 2,
        activeJobs: 1,
        reviewJobs: 1,
        blockedJobs: 0,
        statuses: { running: 1 },
      },
    ];
    const client = createClient({
      "codefarm.list": {
        jobs: [
          {
            id: "cf_20260625_001",
            status: "running",
            runtime: "codex-cli",
            cwd: "/Users/me/agent-space",
            taskIntent: "Run tests",
          },
        ],
      },
      "codefarm.project": {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        contextFiles: [{ path: "AGENTS.md", kind: "agent_context", content: "Stay focused." }],
        gsd: { available: true, files: [{ path: ".gsd/STATE.md", content: "Milestone S02" }] },
        projectTerminal: {
          session: "codefarm_agent-space-12345678",
          attachCommand: "tmux attach -t codefarm_agent-space-12345678",
          running: true,
        },
      },
    });

    await selectCodefarmRepo({ host, client: client as never, repo: "/Users/me/agent-space" });

    expect(client.request).toHaveBeenCalledWith("codefarm.list", {
      repo: "/Users/me/agent-space",
    });
    expect(client.request).toHaveBeenCalledWith("codefarm.project", {
      repo: "/Users/me/agent-space",
    });
    expect(state.selectedRepo).toBe("/Users/me/agent-space");
    expect(state.jobs).toEqual([expect.objectContaining({ id: "cf_20260625_001" })]);
    expect(state.selectedJobId).toBe("cf_20260625_001");
    expect(state.project).toEqual(
      expect.objectContaining({
        repo: "/Users/me/agent-space",
        contextFiles: [expect.objectContaining({ path: "AGENTS.md" })],
      }),
    );
  });

  it("loads project context and GSD state for the selected repo", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.selectedRepo = "/Users/me/agent-space";
    const client = createClient({
      "codefarm.project": {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        jobs: { totalJobs: 3, activeJobs: 1, statuses: { running: 1 } },
        contextFiles: [
          {
            path: "AGENTS.md",
            title: "AGENTS.md",
            kind: "agent_context",
            content: "Use GSD and keep proof current.",
            truncated: false,
          },
        ],
        gsd: {
          available: true,
          files: [
            {
              path: ".gsd/STATE.md",
              title: "STATE.md",
              kind: "gsd_state",
              content: "Milestone: S02 proof",
              truncated: false,
            },
          ],
        },
        projectTerminal: {
          session: "codefarm_agent-space-12345678",
          attachCommand: "tmux attach -t codefarm_agent-space-12345678",
          running: true,
          pane: "%1",
          command: "zsh",
          cwd: "/Users/me/agent-space",
          terminal: {
            source: "tmux",
            truncated: false,
            lines: ["project booted", "ready"],
          },
        },
      },
    });

    await loadCodefarmProject({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("codefarm.project", {
      repo: "/Users/me/agent-space",
    });
    expect(state.project).toEqual(
      expect.objectContaining({
        repo: "/Users/me/agent-space",
        gsd: expect.objectContaining({ available: true }),
        projectTerminal: expect.objectContaining({
          session: "codefarm_agent-space-12345678",
          running: true,
          pane: "%1",
          cwd: "/Users/me/agent-space",
          terminal: expect.objectContaining({
            source: "tmux",
            lines: ["project booted", "ready"],
          }),
        }),
      }),
    );
  });

  it("sends project terminal input and refreshes the project snapshot", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.selectedRepo = "/Users/me/agent-space";
    state.terminalInput = "echo hello";
    const client = createClient({
      "codefarm.project.terminal.send": {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        jobs: { totalJobs: 0, activeJobs: 0, statuses: {} },
        contextFiles: [],
        gsd: { available: true, files: [] },
        projectTerminal: {
          session: "codefarm_agent-space-12345678",
          running: true,
          persistent: true,
          terminal: {
            source: "tmux",
            truncated: false,
            lines: ["echo hello", "hello"],
          },
        },
      },
    });

    await sendCodefarmProjectTerminalInput({
      host,
      client: client as never,
      repo: "/Users/me/agent-space",
      input: "echo hello",
      enter: true,
    });

    expect(client.request).toHaveBeenCalledWith("codefarm.project.terminal.send", {
      repo: "/Users/me/agent-space",
      input: "echo hello",
      enter: true,
    });
    expect(state.terminalSending).toBe(false);
    expect(state.terminalInput).toBe("");
    expect(state.project).toEqual(
      expect.objectContaining({
        projectTerminal: expect.objectContaining({
          terminal: expect.objectContaining({ lines: ["echo hello", "hello"] }),
        }),
      }),
    );
  });

  it("observes the selected job through the first-class Code Farm observe method", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.selectedRepo = "/Users/me/agent-space";
    state.jobs = [{ id: "cf_20260625_001", status: "running" }];
    state.selectedJobId = "cf_20260625_001";
    const client = createClient({
      "codefarm.observe": {
        jobId: "cf_20260625_001",
        repo: "/Users/me/agent-space",
        status: "running",
        terminal: { source: "tmux", truncated: false, lines: ["worker booted"] },
        tmux: {
          available: true,
          enabled: true,
          session: "codefarm_agent-space-12345678",
          window: "cf_20260625_001",
          pane: "%1",
          attachCommand: "tmux attach -t codefarm_agent-space-12345678",
          note: null,
        },
      },
    });

    await observeCodefarmJob({
      host,
      client: client as never,
      repo: "/Users/me/agent-space",
      jobId: "cf_20260625_001",
      lines: 80,
    });

    expect(client.request).toHaveBeenCalledWith("codefarm.observe", {
      repo: "/Users/me/agent-space",
      jobId: "cf_20260625_001",
      lines: 80,
    });
    expect(state.observation).toMatchObject({
      jobId: "cf_20260625_001",
      terminal: { source: "tmux", lines: ["worker booted"] },
    });
  });

  it("loads jobs from the manual repo fallback when discovery misses a repo", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.repoInput = "/Users/me/manual-repo";
    const client = createClient({ "codefarm.list": { jobs: [] } });

    await loadCodefarmJobs({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("codefarm.list", {
      repo: "/Users/me/manual-repo",
    });
    expect(state.selectedRepo).toBe("/Users/me/manual-repo");
  });
});
