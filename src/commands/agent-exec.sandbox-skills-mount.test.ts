import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { splitSandboxBindSpec } from "../agents/sandbox/bind-spec.js";
import { DOCKER_SANDBOX_ENGINE, execContainer } from "../agents/sandbox/container-engine.js";
import { resolveDockerSourceNamespace } from "../agents/sandbox/docker-mount-source.js";
import {
  prepareSandboxMountPlan,
  sandboxMountPlanMatchesContainer,
} from "../agents/sandbox/mount-plan.js";
import { isPathInside } from "../infra/path-guards.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runAgentExecWithMock } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

vi.mock("../agents/sandbox/container-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/sandbox/container-engine.js")>();
  return { ...actual, execContainer: vi.fn() };
});
vi.mock("../agents/sandbox/docker-mount-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/sandbox/docker-mount-source.js")>();
  return { ...actual, resolveDockerSourceNamespace: vi.fn() };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function successResult(text = "done") {
  return {
    payloads: [{ text }],
    meta: { durationMs: 5, finalAssistantVisibleText: text },
  };
}

type SandboxObservation = {
  stateDir: string;
  skillsWorkspaceDir: string;
  plan: Awaited<ReturnType<typeof prepareSandboxMountPlan>>;
};

/** Captures the sandbox layout a run would mount, from inside that run's state redirect. */
async function observeSandboxLayout(workspaceDir: string): Promise<SandboxObservation> {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
  const { resolveSandboxWorkspaceLayoutPaths } = await import("../agents/sandbox/shared.js");
  const layout = resolveSandboxWorkspaceLayoutPaths({
    cfg: {
      scope: "agent",
      workspaceAccess: "rw",
      workspaceRoot: path.join(stateDir, "sandboxes"),
    },
    rawSessionKey: "agent:main:main",
    workspaceDir,
  });
  await fs.mkdir(path.join(layout.skillsWorkspaceDir, "skills"), { recursive: true });
  const plan = await prepareSandboxMountPlan({
    engine: DOCKER_SANDBOX_ENGINE,
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    skillsWorkspaceDir: layout.skillsWorkspaceDir,
    workdir: "/workspace",
    workspaceAccess: "rw",
  });
  return { stateDir, skillsWorkspaceDir: layout.skillsWorkspaceDir, plan };
}

function mountsFor(observation: SandboxObservation) {
  return observation.plan.binds.flatMap((bind) => {
    const parsed = splitSandboxBindSpec(bind);
    if (!parsed) {
      return [];
    }
    return [
      {
        Type: "bind",
        Source: parsed.host,
        Destination: parsed.container,
        RW: !parsed.options.split(",").includes("ro"),
      },
    ];
  });
}

async function runAgentExecOnce(workspaceDir: string, observations: SandboxObservation[]) {
  const result = await runAgentExecWithMock(
    "inspect",
    { configOverride: ['{"agents":{"defaults":{"systemAgent":{"agentId":"main"}}}}'] },
    createTestRuntime(),
    async () => {
      observations.push(await observeSandboxLayout(workspaceDir));
      return successResult();
    },
  );
  expect(result.envelope.error).toBeUndefined();
  expect(result.exitCode).toBe(0);
}

describe("sandbox skills mounts across temporary agent exec state", () => {
  it("reuses one skills source for containers that outlive a temporary state dir", async () => {
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue(undefined);
    const installationStateDir = await fs.realpath(tempDirs.make("openclaw-agent-exec-state-"));
    const workspaceDir = path.join(installationStateDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const observations: SandboxObservation[] = [];
    await withEnvAsync({ OPENCLAW_STATE_DIR: installationStateDir }, async () => {
      for (let run = 0; run < 2; run += 1) {
        // Each invocation is a fresh process in production, so its state constants reload.
        vi.resetModules();
        await runAgentExecOnce(workspaceDir, observations);
      }
    });

    expect(observations).toHaveLength(2);
    const first = observations[0]!;
    const second = observations[1]!;
    expect(first.stateDir).not.toBe(second.stateDir);
    expect(isPathInside(installationStateDir, first.skillsWorkspaceDir)).toBe(true);
    expect(second.skillsWorkspaceDir).toBe(first.skillsWorkspaceDir);

    vi.mocked(execContainer).mockResolvedValue({
      stdout: JSON.stringify({ Mounts: mountsFor(first), Tmpfs: null }),
      stderr: "",
      code: 0,
    });
    await expect(
      sandboxMountPlanMatchesContainer({
        engine: DOCKER_SANDBOX_ENGINE,
        containerName: "retained",
        plan: second.plan,
      }),
    ).resolves.toBe(true);
  });
});
