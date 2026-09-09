import { describe, it, expect, vi, afterEach } from "vitest";
const obs = vi.hoisted(() => ({ events: [] as string[], note: vi.fn() }));
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
vi.mock("../projects/project-registry.js", () => ({
  listProjectRegistry: () => [
    {
      id: "synthetic-clone",
      displayName: "Synthetic clone",
      repoRoot: "/synthetic/clone",
      source: "cloned",
    },
  ],
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
vi.mock("../commands/doctor-db-bloat.js", () => ({
  noteSqliteDatabaseBloat: () => {
    obs.events.push("db-size-advice");
  },
}));
vi.mock("../commands/doctor/shared/active-tool-schema-warnings.js", () => ({
  collectActiveToolSchemaProjectionWarnings: async () => {
    obs.events.push("active-tool-schema");
    return ["synthetic advisory"];
  },
}));
vi.mock("../commands/doctor-state-integrity.js", () => ({
  collectWorkspaceBackupTip: () => undefined,
}));
vi.mock("../commands/doctor-workspace.js", () => ({
  MEMORY_SYSTEM_PROMPT: "synthetic",
  shouldSuggestMemorySystem: async () => {
    obs.events.push("workspace-suggestions");
    return false;
  },
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
function context(env: NodeJS.ProcessEnv) {
  const ctx = createDoctorHealthFlowContext({
    env,
    options: { repair: true, yes: true, nonInteractive: true, workspaceSuggestions: true },
  });
  ctx.prompter.shouldRepair = true;
  return ctx;
}
afterEach(() => vi.unstubAllEnvs());
describe("update Doctor diagnostic scope", () => {
  it.each(["standalone", "package-swap", "post-core"])(
    "keeps standalone advisory work outside update: %s",
    async (mode) => {
      const env: NodeJS.ProcessEnv =
        mode === "standalone" ? {} : { OPENCLAW_UPDATE_IN_PROGRESS: "1" };
      if (mode === "post-core") {
        env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE = "1";
      }
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", env.OPENCLAW_UPDATE_IN_PROGRESS);
      vi.stubEnv(
        "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
        env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE,
      );
      const ids = new Set([
        "doctor:project-clone-shape",
        "doctor:db-bloat",
        "doctor:active-tool-schema-warnings",
        "doctor:workspace-suggestions",
      ]);
      const selected = resolveDoctorHealthContributions().filter((c) => ids.has(c.id));
      expect(selected).toHaveLength(ids.size);
      obs.events = [];
      obs.note.mockClear();
      const ctx = context(env);
      const snapshot = vi.fn();
      ctx.runWithPluginMetadataSnapshot = (_scope, run) => {
        snapshot();
        return run();
      };
      await runDoctorHealthContributionList(ctx, selected);
      expect(obs.events).toEqual(
        mode === "standalone"
          ? [
              "active-tool-schema",
              "project-git",
              "project-git",
              "project-git",
              "db-size-advice",
              "workspace-suggestions",
            ]
          : [],
      );
      expect(snapshot).toHaveBeenCalledTimes(mode === "standalone" ? 4 : 0);
      if (mode === "standalone") {
        expect(obs.note).toHaveBeenCalledWith("synthetic advisory", "Doctor warnings");
        expect(obs.note).not.toHaveBeenCalledWith(expect.anything(), "Update Doctor scope");
      } else {
        expect(obs.note).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(
            /Omitted during update:.*Project clones.*SQLite database size.*Workspace suggestions.*\nRun `openclaw doctor`/,
          ),
          "Update Doctor scope",
        );
      }
    },
  );
});
