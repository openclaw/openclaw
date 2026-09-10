import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";

const fixture = vi.hoisted(() => ({
  root: "",
  runtime: "codex" as "codex" | "claude-cli",
  prefix: vi.fn(async (_params: { writableRuntimePaths: string[] }) => {
    // Stop at the real entrypoint's mount request; do not launch a payload.
    throw new Error("fixture mount boundary reached");
  }),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => path.join(fixture.root, "home"),
}));
vi.mock("../agents/agent-scope-config.js", () => ({
  resolveAgentDir: () => path.join(fixture.root, "agents", "selected", "agent"),
  resolveDefaultAgentDir: () => path.join(fixture.root, "agents", "default", "agent"),
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../config/paths.js", () => ({
  resolveConfigPath: () => path.join(fixture.root, "absent-config.json"),
}));
vi.mock("../infra/runtime-process-url.js", () => ({}));
vi.mock("../infra/runtime-worker-url.js", () => ({}));
vi.mock("../infra/owned-runtime-process-context.js", () => ({}));
vi.mock("../node-host/node-worker-process-identity.js", () => ({
  requireNodeWorkerProcessIdentity: () => ({}),
}));
vi.mock("./supervised-attempt-candidate.js", () => ({}));
vi.mock("./supervised-attempt-custody.js", () => ({
  readSupervisedAttemptContext: () => ({
    task: { runtime: fixture.runtime, agentId: "selected", flowId: "flow", episode: 1 },
    plan: { allocationId: "allocation", storage: {} },
    allocationRoot: path.join(fixture.root, "allocation"),
    sourceWorkspace: null,
  }),
  bindSupervisedAttemptResources: async () => {},
  assertSupervisedAttemptResourcesCurrent: () => {},
}));
vi.mock("./supervised-attempt-workspace.js", () => ({
  prepareSupervisedAttemptWorkspace: async () => ({}),
  supervisedAttemptWorkspacePayloadPrefix: fixture.prefix,
}));
vi.mock("./supervised-command-child.js", () => ({}));
vi.mock("./supervised-command-custody.js", () => ({
  bindSupervisedCommandResources: () => {},
}));
vi.mock("./supervised-command-resources.js", () => ({
  inspectSupervisedCommandScope: async () => ({}),
}));
vi.mock("./supervised-operation.store.js", () => ({
  assertSupervisedOperationCurrent: () => {},
}));
vi.mock("./supervised-operation.types.js", () => ({}));
vi.mock("./supervised-process-resources.js", () => ({}));
vi.mock("./supervised-review-context.js", () => ({
  readSupervisedReviewContext: () => ({
    execution: {},
    operation: {},
    profile: { runtime: fixture.runtime, agentId: "selected" },
    reservedRoot: path.join(fixture.root, "allocation"),
  }),
}));
vi.mock("./supervised-runtime-workspace.js", () => ({
  prepareSupervisedRuntimeWorkspace: async () => ({}),
  supervisedRuntimeWorkspacePayloadPrefix: fixture.prefix,
}));
vi.mock("./supervised-runtime-diagnostic.js", () => ({
  supervisedRuntimeFailureDiagnostic: () => "fixture stopped",
}));
vi.mock("./supervised-task.decision.js", () => ({}));
vi.mock("./supervised-task.store.js", () => ({}));
vi.mock("./supervised-workflow.store.js", () => ({
  getSupervisedWorkflowContract: () => null,
}));

const dirs = createTempDirTracker();
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(async () => {
  vi.resetModules();
  fixture.prefix.mockClear();
  fixture.root = dirs.make("supervised-native-root-");
  for (const directory of ["home/.codex", "home/.claude", "selected-codex", "selected-claude"]) {
    await fs.mkdir(path.join(fixture.root, directory), { recursive: true, mode: 0o700 });
  }
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, "/tmp");
  }
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  dirs.cleanup();
});

// These exercise both existing consumers, not only the extracted selector. The
// default Codex cases fail on the original consumers because their mount request
// lacks the existing ~/.codex directory. No real auth, process or mount is used.
describe.skipIf(!process.getuid)("native state roots at payload dispatch", () => {
  for (const consumer of ["attempt", "review"] as const) {
    describe(consumer, () => {
      it.each([
        { runtime: "codex", codex: undefined, claude: "selected-claude", expected: "home/.codex" },
        { runtime: "codex", codex: "", claude: "selected-claude", expected: "home/.codex" },
        {
          runtime: "codex",
          codex: "selected-codex",
          claude: undefined,
          expected: "selected-codex",
        },
        { runtime: "codex", codex: "missing-codex", claude: undefined, expected: undefined },
        {
          runtime: "claude-cli",
          codex: "selected-codex",
          claude: undefined,
          expected: "home/.claude",
        },
        {
          runtime: "claude-cli",
          codex: "selected-codex",
          claude: "selected-claude",
          expected: "selected-claude",
        },
        { runtime: "claude-cli", codex: "selected-codex", claude: "", expected: undefined },
      ] as const)(
        "selects $runtime state with CODEX_HOME=$codex and CLAUDE_CONFIG_DIR=$claude",
        async (testCase) => {
          fixture.runtime = testCase.runtime;
          const envPath = (value: string | undefined) =>
            value ? path.join(fixture.root, value) : value;
          vi.stubEnv("CODEX_HOME", envPath(testCase.codex));
          vi.stubEnv("CLAUDE_CONFIG_DIR", envPath(testCase.claude));
          const database = path.join(fixture.root, "state", "tasks.sqlite");
          process.argv = [
            process.execPath,
            "fixture-entrypoint",
            "--namespace",
            "resource",
            ...(consumer === "review" ? ["allocation"] : []),
            database,
            "mnt:[1]",
            "user:[1]",
          ];
          if (consumer === "attempt") {
            await import("./supervised-attempt-process.js");
          } else {
            await import("./supervised-review-process.js");
          }
          expect(fixture.prefix).toHaveBeenCalledTimes(1);
          const roots = fixture.prefix.mock.calls[0]![0].writableRuntimePaths;
          const nonNativeRoots = new Set([
            path.dirname(database),
            path.join(fixture.root, "agents", "selected"),
            path.join(fixture.root, "agents", "default"),
          ]);
          expect(roots.filter((root) => !nonNativeRoots.has(root))).toEqual(
            testCase.expected ? [path.join(fixture.root, testCase.expected)] : [],
          );
          if (testCase.codex === "missing-codex") {
            await expect(fs.access(path.join(fixture.root, "missing-codex"))).rejects.toMatchObject(
              {
                code: "ENOENT",
              },
            );
          }
        },
      );
    });
  }
});
