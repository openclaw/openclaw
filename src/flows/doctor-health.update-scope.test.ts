import { it, expect, vi, afterEach } from "vitest";
const obs = vi.hoisted(() => ({
  events: [] as string[],
  note: vi.fn(),
  codexBwrap: vi.fn(),
  record<T>(event: string, result: T) {
    this.events.push(event);
    return result;
  },
}));
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: () => ["fixture"],
  tryResolveSoleAgentId: () => "fixture",
  resolveAgentWorkspaceDir: () => "/synthetic/workspace",
  resolveAgentConfig: () => ({}),
  resolveAgentDir: () => "/synthetic/agent",
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: obs.note }));
vi.mock("../commands/backup-health.js", () => ({ noteBackupDoctorHint: () => {} }));
vi.mock("../state/config-machine-state-write.js", () => ({ writeConfigMachineState: () => {} }));
// mock-isolation: use a synthetic cloned project without querying operator project state.
vi.mock("../projects/project-registry.js", () => ({
  listProjectRegistry: async () => [{ repoRoot: "/synthetic/clone", source: "cloned" }],
}));
vi.mock("../agents/worktrees/git.js", () => ({ gitEnvironment: (env: unknown) => env }));
vi.mock("../infra/git-exec.js", () => ({
  executeGitCommand: async (_root: string, args: string[]) => {
    obs.events.push("project-git");
    return {
      termination: "exit",
      code: args[0] === "config" ? 1 : 0,
      stdout: args[0] === "rev-parse" ? "false\n" : "",
      stdoutTruncatedBytes: 0,
    };
  },
}));
// mock-isolation: record advisory selection without opening operator databases.
vi.mock("../commands/doctor-db-bloat.js", () => ({
  noteSqliteDatabaseBloat: () => obs.record("db-size-advice", undefined),
}));
vi.mock("../commands/doctor-sandbox.js", () => ({
  noteCodexBwrapNamespaceWarnings: obs.codexBwrap,
}));
// mock-isolation: record advisory selection without reading real workspace bootstrap files.
vi.mock("../commands/doctor-bootstrap-size.js", () => ({
  noteBootstrapFileSize: () => obs.record("bootstrap-size-advice", undefined),
}));
// mock-isolation: record credential-advice selection without accessing real credentials.
vi.mock("../gateway/github-public-api.js", () => ({
  hasConfiguredGitHubApiCredential: () => obs.record("github-credential-advice", false),
}));
// mock-isolation: record advisory selection without reading or modifying real workspaces.
vi.mock("../commands/doctor-workspace.js", () => ({
  collectWorkspaceBackupTip: () => undefined,
  MEMORY_SYSTEM_PROMPT: "synthetic",
  shouldSuggestMemorySystem: async () => obs.record("workspace-suggestions", false),
}));
vi.mock("./doctor-workspace-suggestion-scopes.js", () => ({
  resolveDoctorWorkspaceSuggestionScopes: () => [
    { agentId: "fixture", workspaceDir: "/synthetic/workspace", labelAgent: false },
  ],
}));
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";
afterEach(() => vi.unstubAllEnvs());
it.each(["standalone", "post-core"])(
  "keeps standalone advisory work outside update: %s",
  async (mode) => {
    const standalone = mode === "standalone";
    const env: NodeJS.ProcessEnv = standalone
      ? {}
      : {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        };
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", env.OPENCLAW_UPDATE_IN_PROGRESS);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE);
    const ids = new Set([
      "doctor:project-clone-shape",
      "doctor:db-bloat",
      "doctor:codex-bwrap",
      "doctor:workspace-suggestions",
      "doctor:github-projects",
      "doctor:bootstrap-size",
    ]);
    const selected = resolveDoctorHealthContributions().filter((c) => ids.has(c.id));
    expect(selected).toHaveLength(ids.size);
    obs.events = [];
    obs.note.mockClear();
    obs.codexBwrap.mockClear();
    const ctx = createDoctorHealthFlowContext({
      env,
      options: { repair: true, yes: true, nonInteractive: true, workspaceSuggestions: true },
    });
    ctx.prompter.shouldRepair = true;
    const snapshot = vi.fn();
    ctx.runWithPluginMetadataSnapshot = (_scope, run) => {
      snapshot();
      return run();
    };
    await runDoctorHealthContributionList(ctx, selected);
    expect(obs.events).toEqual(
      standalone
        ? [
            "project-git",
            "project-git",
            "project-git",
            "db-size-advice",
            "github-credential-advice",
            "bootstrap-size-advice",
            "workspace-suggestions",
          ]
        : [],
    );
    expect(snapshot).toHaveBeenCalledTimes(standalone ? ids.size : 0);
    if (standalone) {
      expect(obs.codexBwrap).toHaveBeenCalledExactlyOnceWith(ctx.cfg, {
        env,
        cwd: "/synthetic/workspace",
      });
      expect(obs.note).not.toHaveBeenCalledWith(expect.anything(), "Update Doctor scope");
    } else {
      expect(obs.codexBwrap).not.toHaveBeenCalled();
      expect(obs.note).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(
          /Omitted during update:.*Project clones.*SQLite database size.*Codex bwrap sandbox.*Workspace suggestions.*\nRun `openclaw doctor`/,
        ),
        "Update Doctor scope",
      );
    }
  },
);
