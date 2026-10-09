import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as gitExec from "../../infra/git-exec.js";
import {
  finalizeUpdateRestartSentinelRunningVersion,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { createGatewayUpdateLifecycle } from "../../infra/update-check-lifecycle.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";

const mocks = vi.hoisted(() => ({
  root: "",
  handoff:
    vi.fn<
      typeof import("../../infra/update-managed-service-handoff.js").startManagedServiceUpdateHandoff
    >(),
}));

vi.mock("../../infra/openclaw-root.js", async (original) => ({
  ...(await original<typeof import("../../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => mocks.root,
}));
vi.mock("../../daemon/gateway-entrypoint.js", async (original) => ({
  ...(await original<typeof import("../../daemon/gateway-entrypoint.js")>()),
  resolveGatewayInstallEntrypoint: async (root: string) => path.join(root, "dist/index.js"),
}));
vi.mock("../../infra/supervisor-markers.js", async (original) => ({
  ...(await original<typeof import("../../infra/supervisor-markers.js")>()),
  detectRespawnSupervisor: () => "launchd",
}));
vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  startManagedServiceUpdateHandoff: mocks.handoff,
  claimManagedServiceUpdateHandoff: () => true,
  transferManagedServiceUpdateHandoff: async () => true,
  cancelManagedServiceUpdateHandoff: vi.fn(),
}));
vi.mock("../../infra/restart.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart.js")>()),
  scheduleGatewayRestart: () => ({ scheduled: true }),
}));

let home: TempHomeEnv;
let lifecycle: ReturnType<typeof createGatewayUpdateLifecycle>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let sha: string;

async function git(...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", mocks.root, ...args], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-update-admission-freshness-");
  mocks.root = await fs.realpath(home.home);
  await fs.writeFile(
    path.join(mocks.root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
  );
  await git("init", "--initial-branch=main");
  await git(
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  sha = await git("rev-parse", "HEAD");
  await git("checkout", "--detach", sha);
  scheduler = createTestGatewayScheduler();
  lifecycle = createGatewayUpdateLifecycle(scheduler);
  mocks.handoff.mockReset().mockImplementation(async (params) => ({
    status: "started",
    pid: 12345,
    command: "openclaw update",
    logPath: path.join(mocks.root, "handoff.log"),
    handoffId: expectDefined(params.handoffId, "prepared handoff identity"),
    installRoot: params.root,
  }));
});

afterEach(async () => {
  await lifecycle?.stop();
  await scheduler?.stop();
  vi.restoreAllMocks();
  await home?.restore();
});

async function publishReceipt(root = mocks.root, revision = sha, upstreamRef = "origin/main") {
  await writeRestartSentinel({
    kind: "update",
    status: "ok",
    ts: Date.now(),
    stats: {
      mode: "git",
      root,
      before: { sha: "0".repeat(40) },
      after: { sha: revision, upstreamRef, version: "2026.9.4" },
    },
  });
  await finalizeUpdateRestartSentinelRunningVersion("2026.9.4", process.env, revision, root);
}

async function requestUpdate(upstreamRef = "origin/main") {
  const { updateHandlers } = await import("./update.js");
  const respond = vi.fn();
  await expectDefined(
    updateHandlers["update.run"],
    "registered update handler",
  )({
    params: { target: { kind: "git", upstreamRef, upstreamSha: sha } },
    respond,
    context: { getRuntimeConfig: () => ({ update: { channel: "dev" } }) },
  } as never);
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]?.[1];
}

async function configureCurrentSource() {
  await git("remote", "add", "origin", mocks.root);
  await git("update-ref", "refs/remotes/origin/main", sha);
}

it.each(["receipt", "branch", "sha"] as const)(
  "admits current verified facts after startup lacked %s",
  async (probe) => {
    if (probe === "receipt") {
      expect((await lifecycle.initialize()).status.git?.upstream).toBeNull();
      await configureCurrentSource();
      await publishReceipt();
    } else {
      await configureCurrentSource();
      await publishReceipt();
      const execute = gitExec.executeGitCommand;
      const failure = vi
        .spyOn(gitExec, "executeGitCommand")
        .mockImplementation((root, args, options) =>
          args.join(" ") === (probe === "branch" ? "rev-parse --abbrev-ref HEAD" : "rev-parse HEAD")
            ? Promise.reject(new Error("Git probe temporarily unavailable"))
            : execute(root, args, options),
        );
      const initial = (await lifecycle.initialize()).status.git;
      expect(probe === "branch" ? initial?.branch : initial?.sha).toBeNull();
      failure.mockRestore();
    }

    const response = await requestUpdate();

    expect(response).toMatchObject({ ok: true });
    expect(mocks.handoff).toHaveBeenCalledOnce();
    expect(mocks.handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        root: mocks.root,
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: sha },
      }),
    );
  },
);

it.each(["absent", "root", "sha", "ref"] as const)(
  "admits a valid current target despite %s receipt history",
  async (history) => {
    await lifecycle.initialize();
    await configureCurrentSource();
    if (history !== "absent") {
      await publishReceipt(
        history === "root" ? path.dirname(mocks.root) : mocks.root,
        history === "sha" ? "1".repeat(40) : sha,
        history === "ref" ? "other/main" : "origin/main",
      );
    }
    const probes = vi.spyOn(gitExec, "executeGitCommand");

    const response = await requestUpdate();

    expect(response).toMatchObject({ ok: true });
    expect(mocks.handoff).toHaveBeenCalledOnce();
    expect(mocks.handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: sha },
      }),
    );
    expect(
      probes.mock.calls.some(([, args]) => ["fetch", "ls-remote"].includes(args[0] ?? "")),
    ).toBe(false);
  },
);

it("rejects a pinned target that disagrees with live tracking", async () => {
  await lifecycle.initialize();
  await configureCurrentSource();
  await git("config", "branch.main.remote", "origin");
  await git("config", "branch.main.merge", "refs/heads/main");
  await publishReceipt(mocks.root, sha, "other/main");

  const response = await requestUpdate("other/main");

  expect(response).toMatchObject({
    ok: false,
    result: { reason: "update-target-upstream-mismatch", steps: [] },
  });
  expect(mocks.handoff).not.toHaveBeenCalled();
});
