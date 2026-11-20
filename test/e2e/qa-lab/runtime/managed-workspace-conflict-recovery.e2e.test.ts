// QA Lab product proof for managed-workspace conflict recovery.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { localWorkspaceProjectionPath } from "../../../../src/gateway/worker-environments/local-workspace-checkout.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const MANAGED_SANDBOX = {
  mode: "all" as const,
  backend: "docker" as const,
  scope: "session" as const,
  workspaceAccess: "rw" as const,
  browser: { enabled: false },
  prune: { idleHours: 0, maxAgeDays: 0 },
};

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trimEnd();
}

async function initializeRepository(root: string) {
  const repo = path.join(root, "source");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initialize conflict fixture");
  return await fs.realpath(repo);
}

async function waitForDirectory(directory: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await fs.stat(directory).then(
        (stat) => stat.isDirectory(),
        () => false,
      )
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`Timed out waiting for ${directory}`);
}

describe("managed workspace conflict recovery product proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let owner: ReturnType<typeof createQaLiveLaneGateway> | undefined;

  afterEach(async () => {
    if (owner) {
      await stopQaGatewayFixture(owner);
      owner = undefined;
    }
  });

  it(
    "recovers a preserved conflict through Files and runs the next guest turn",
    { timeout: 300_000 },
    async () => {
      const fixtureRoot = tempDirs.make(
        "openclaw-managed-conflict-",
        await fs.realpath(os.tmpdir()),
      );
      const repo = await initializeRepository(fixtureRoot);
      owner = createQaLiveLaneGateway();
      const harness = await owner.start({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna",
        transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              skipBootstrap: true,
              workspace: fixtureRoot,
              sandbox: {
                ...MANAGED_SANDBOX,
                workspaceRoot: path.join(fixtureRoot, "sandboxes"),
                docker: {
                  image: process.env.OPENCLAW_SANDBOX_TEST_IMAGE ?? "openclaw-sandbox:trixie-slim",
                  containerPrefix: `oc-conflict-${process.pid}-`,
                },
              },
            },
          },
        }),
      });
      const created = (await harness.gateway.call(
        "sessions.create",
        {
          agentId: "qa",
          worktree: true,
          worktreeName: "qa-conflict-recovery",
          worktreeBaseRef: "main",
          cwd: repo,
        },
        { timeoutMs: 30_000 },
      )) as {
        key: string;
        worktree: { id: string; path: string };
      };
      const stateDir = path.join(await fs.realpath(harness.gateway.tempRoot), "state");
      const projectionDir = await localWorkspaceProjectionPath({
        // The live Gateway owns the full record; the helper only reads identity and env.
        worktree: { id: created.worktree.id },
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      } as never);
      const canonicalFile = path.join(created.worktree.path, "preview.html");
      const guestFile = path.join(projectionDir, "preview.html");

      const turn = async (message: string) => {
        const started = (await harness.gateway.call(
          "chat.send",
          {
            sessionKey: created.key,
            message,
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: 60_000 },
        )) as { runId?: string; status?: string };
        expect(started.status).toBe("started");
        expect(started.runId).toBeTruthy();
        return await harness.gateway.call(
          "agent.wait",
          { runId: started.runId, timeoutMs: 180_000 },
          { timeoutMs: 190_000 },
        );
      };

      // First turn provisions the Docker sandbox and its private projection.
      await expect(turn("Reply exactly READY.")).resolves.toMatchObject({ status: "ok" });
      await waitForDirectory(projectionDir, 60_000);
      await fs.mkdir(projectionDir, { recursive: true });
      await fs.writeFile(guestFile, "guest draft\n");
      await fs.writeFile(canonicalFile, "administrator draft\n");

      // The next turn checkpoints the divergence and preserves the conflict.
      await turn("Reply exactly CONFLICT.").catch(() => undefined);

      const guestHash = createHash("sha256").update("guest draft\n").digest("hex");
      const saved = await harness.gateway.call(
        "sessions.files.set",
        {
          sessionKey: created.key,
          path: "preview.html",
          content: "merged administrator and guest draft\n",
          expectedHash: guestHash,
          expectedSource: {
            workspaceId: created.worktree.id,
            root: created.worktree.path,
            fileRoot: created.worktree.path,
          },
        },
        { timeoutMs: 120_000 },
      );
      expect(saved).toMatchObject({ file: { path: "preview.html" } });

      // The original task continues through the running Gateway.
      await expect(turn("Reply exactly CONTINUED.")).resolves.toMatchObject({ status: "ok" });
      await expect(fs.readFile(canonicalFile, "utf8")).resolves.toBe(
        "merged administrator and guest draft\n",
      );
      await expect(fs.readFile(guestFile, "utf8")).resolves.toBe(
        "merged administrator and guest draft\n",
      );
    },
  );
});
