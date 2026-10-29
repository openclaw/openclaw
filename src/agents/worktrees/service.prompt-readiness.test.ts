import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandRunner from "../../process/exec-runner.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import { git } from "./git-fixture.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

// Native cloning is the only substituted boundary; Git and publication use their real owners.
vi.mock("./filesystem-backend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./filesystem-backend.js")>()),
  detectWorktreeFilesystemBackend: vi.fn(),
}));

const initializeRepository = useManagedWorktreeTestRepository();
const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
let repo: string;
let service: ManagedWorktreeService;
beforeEach(async () => {
  useInProcessWorktreeCapacityTransport();
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
  const root = roots.make("worktree-prompt-clone-");
  repo = await initializeRepository(root);
  vi.mocked(detectWorktreeFilesystemBackend)
    .mockReset()
    .mockResolvedValue(createCopyWorktreeBackend());
  service = new ManagedWorktreeService({
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    getConfig: () => ({}),
  });
});

it.each(["ready", "consumer-rejection", "index-failure"])(
  "publishes cloned prompt files before index finalization (%s)",
  async (outcome) => {
    await service.create({ repoRoot: repo, name: "prompt-template", baseRef: "HEAD" });
    let promptPath: string | undefined;
    let refreshedAfterPrompt = false;
    const run = commandRunner.runCommandWithTimeout;
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("update-index") && argv.includes("--refresh")) {
        refreshedAfterPrompt = promptPath !== undefined;
        if (outcome === "index-failure") {
          throw new Error("index finalization failed");
        }
      }
      return await run(argv, options);
    });
    const onPromptReady = vi.fn(async (facts: { path: string; commit: string }) => {
      promptPath = facts.path;
      expect(await fs.readFile(path.join(facts.path, "README.md"), "utf8")).toBe("base\n");
      expect(await git(facts.path, "rev-parse", "HEAD")).toBe(facts.commit);
      if (outcome === "consumer-rejection") {
        throw new Error("prompt consumer canceled");
      }
    });
    const creation = service.create({
      repoRoot: repo,
      name: "prompt-clone",
      baseRef: "HEAD",
      onPromptReady,
    });
    if (outcome !== "ready") {
      await expect(creation).rejects.toThrow(
        outcome === "consumer-rejection" ? "prompt consumer canceled" : "index finalization failed",
      );
      expect(promptPath).toBeDefined();
      await expect(fs.access(promptPath!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(repo, "branch", "--list", "openclaw/prompt-clone")).toBe("");
      expect(refreshedAfterPrompt).toBe(outcome === "index-failure");
    } else {
      const created = await creation;
      expect(created.path).toBe(promptPath);
      expect(refreshedAfterPrompt).toBe(true);
      expect(await git(created.path, "status", "--porcelain")).toBe("");
    }
    expect(onPromptReady).toHaveBeenCalledOnce();
  },
);
