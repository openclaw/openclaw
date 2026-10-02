import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClawInstallRecord } from "../claws/provenance.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn((value: unknown) => value === "cancelled"),
}));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.confirm,
  isCancel: mocks.isCancel,
}));

// This suite exercises config freshness and the real migration writes; lease
// worker admission is covered by the lifecycle integration suite.
vi.mock("../agents/agent-lifecycle-registry.js", () => ({
  withAgentDeletion: async (_agentId: string, run: () => Promise<unknown>) => await run(),
}));

const { runClawsMigrateCommand } = await import("./claws-migrate-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  clearRuntimeConfigSnapshot();
  closeOpenClawStateDatabaseForTest();
});

async function fixture() {
  const root = tempDirs.make("openclaw-claws-migrate-cli-");
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "openclaw.json");
  const env = {
    ...process.env,
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  for (const key of [
    "HOME",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
  ] as const) {
    vi.stubEnv(key, env[key]);
  }
  await mkdir(workspace);
  await writeFile(join(workspace, "AGENTS.md"), "Keep this agent as-is.\n", "utf8");
  const config: OpenClawConfig = {
    gateway: { controlUi: { experimental: { claws: true } } },
    agents: { entries: { worker: { workspace } } },
  };
  await writeFile(configPath, JSON.stringify(config));
  setRuntimeConfigSnapshot(config);
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
    exit: vi.fn(),
  };
  return { root, workspace, stateDir, configPath, env, config, runtime };
}

describe("claws migrate interactive consent", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    mocks.confirm.mockReset();
    mocks.isCancel.mockClear();
  });

  it("does not enroll an existing agent with Claws Labs off", async () => {
    const { configPath, config, env, runtime } = await fixture();
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        gateway: { controlUi: { experimental: { claws: false } } },
      }),
    );

    await runClawsMigrateCommand("worker", { dryRun: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Settings > Labs"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("does not enroll after Claws Labs is switched off during consent", async () => {
    const { configPath, config, env, runtime } = await fixture();
    mocks.confirm.mockImplementation(async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          gateway: { controlUi: { experimental: { claws: false } } },
        }),
      );
      return true;
    });

    await runClawsMigrateCommand("worker", {}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Settings > Labs"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("defaults to no and leaves the existing agent untouched when cancelled", async () => {
    const { stateDir, env, runtime } = await fixture();
    mocks.confirm.mockResolvedValue(false);

    await runClawsMigrateCommand("worker", {}, runtime);

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: false,
        message: expect.stringContaining('"worker"'),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Generated local Claw package files:"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Migration cancelled; no Claw ownership was recorded.",
    );
    await expect(access(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(stateDir, "claws", "local", "worker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["removed", "reassigned"] as const)(
    "rejects an agent %s on disk while interactive consent waits, before enrollment",
    async (change) => {
      const { root, stateDir, configPath, config, env, runtime } = await fixture();
      const reassignedWorkspace = join(root, "reassigned");
      await mkdir(reassignedWorkspace);
      mocks.confirm.mockImplementation(async () => {
        const current: OpenClawConfig = {
          ...config,
          agents: {
            entries: change === "removed" ? {} : { worker: { workspace: reassignedWorkspace } },
          },
        };
        await writeFile(configPath, JSON.stringify(current));
        return true;
      });

      await runClawsMigrateCommand("worker", {}, runtime);

      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringMatching(
          change === "removed" ? /No configured local agent/ : /changed after consent/,
        ),
      );
      await expect(access(join(stateDir, "claws", "local", "worker"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(readClawInstallRecord("worker", { env })).toBeUndefined();
    },
  );
});
