import "../../../../src/test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { resolveSandboxContext } from "../../../../src/agents/sandbox/context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";

afterEach(clearRuntimeConfigSnapshot);

type WorkspaceAccess = "none" | "ro" | "rw";
type SandboxContext = NonNullable<Awaited<ReturnType<typeof resolveSandboxContext>>>;

async function createFixture(name: string, prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${name}-isolation-`));
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  const runtimes: string[] = [];
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  return {
    root,
    config(access: WorkspaceAccess, scope: "agent" | "session" = "session"): OpenClawConfig {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode: "all",
              backend: "docker",
              scope,
              workspaceAccess: access,
              workspaceRoot: path.join(root, "sandboxes"),
              docker: {
                image: process.env.OPENCLAW_SANDBOX_TEST_IMAGE ?? "openclaw-sandbox:trixie-slim",
                containerPrefix: `${prefix}${process.pid}-`,
              },
              browser: { enabled: false },
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      };
      return config;
    },
    async resolve(
      config: OpenClawConfig,
      sessionKey: string,
      workspaceDir: string,
      agentId?: string,
    ) {
      const { resolveSandboxContext } = await import("../../../../src/agents/sandbox/context.js");
      const sandbox = await resolveSandboxContext({
        config,
        sessionKey,
        workspaceDir,
        agentId,
        requireCurrentConfig: true,
      });
      assert(sandbox, "sandbox context missing");
      runtimes.push(sandbox.runtimeId);
      return sandbox;
    },
    async remove(runtimeId: string) {
      const { removeSandboxContainer } = await import("../../../../src/agents/sandbox/manage.js");
      await removeSandboxContainer(runtimeId);
      runtimes.splice(runtimes.indexOf(runtimeId), 1);
    },
    async close(removeFirst = false, beforeRestore?: () => Promise<void>) {
      const { execDocker } = await import("../../../../src/agents/sandbox/docker.js");
      const { removeSandboxContainer } = await import("../../../../src/agents/sandbox/manage.js");
      for (const runtimeId of runtimes) {
        if (removeFirst) {
          try {
            await removeSandboxContainer(runtimeId);
            continue;
          } catch {
            /* Force cleanup below. */
          }
        }
        await execDocker(["rm", "-f", runtimeId], { allowFailure: true });
      }
      await beforeRestore?.();
      env.restore();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function run(
  sandbox: SandboxContext,
  script: string,
  args: string[] = [],
  allowFailure = false,
) {
  if (!sandbox.backend) {
    throw new Error("provisioned sandbox has no backend handle");
  }
  return await sandbox.backend.runShellCommand({ script, args, allowFailure });
}

async function expectOk(sandbox: SandboxContext, script: string, args: string[] = []) {
  const result = await run(sandbox, script, args);
  expect(result.code, result.stderr.toString()).toBe(0);
}

test("Docker enforces none, read-only, and read-write workspace isolation", async () => {
  const fixture = await createFixture("workspace", "oc-qa-");
  const { root } = fixture;
  const unrelatedSentinel = path.join(root, "host-only-sentinel.txt");
  await fs.writeFile(unrelatedSentinel, "host-only");
  const writeWorkspace = (value: string) =>
    `printf ${value} > /workspace/host-sentinel.txt && test "$(cat /workspace/host-sentinel.txt)" = ${value}`;

  try {
    for (const [access, visible, mutationScript, expectedHost, writable] of [
      [
        "none",
        'test ! -e /agent && test ! -e /workspace/host-sentinel.txt && test ! -e "$1"',
        writeWorkspace("private"),
        "original-none",
        true,
      ],
      [
        "ro",
        "grep -Eq ' /agent ' /proc/self/mountinfo && test \"$(cat /agent/host-sentinel.txt)\" = original-ro",
        "printf blocked > /agent/host-sentinel.txt",
        "original-ro",
        false,
      ],
      ["rw", undefined, writeWorkspace("persisted"), "persisted", true],
    ] as const) {
      const hostWorkspace = path.join(root, `agent-${access}-${randomUUID()}`);
      const hostSentinel = path.join(hostWorkspace, "host-sentinel.txt");
      await fs.mkdir(hostWorkspace, { recursive: true });
      if (access === "rw") {
        // Rootful Docker otherwise creates this nested bind target as root,
        // which leaves fixture teardown unable to remove its own temp tree.
        await fs.mkdir(path.join(hostWorkspace, ".openclaw", "sandbox-skills", "skills"), {
          recursive: true,
        });
      }
      await fs.writeFile(hostSentinel, `original-${access}`);

      const config = fixture.config(access);
      setRuntimeConfigSnapshot(config);
      let sandbox: SandboxContext | null = null;
      try {
        sandbox = await fixture.resolve(
          config,
          `agent:workspace-${access}:qa-${randomUUID()}`,
          hostWorkspace,
          `workspace-${access}`,
        );
        expect(sandbox.workspaceAccess).toBe(access);
        await expectOk(sandbox, "grep -Eq ' /workspace ' /proc/self/mountinfo");
        await expectOk(sandbox, 'test ! -e "$1"', [unrelatedSentinel]);

        if (visible) {
          await expectOk(sandbox, visible, [hostSentinel]);
        }
        const mutation = await run(sandbox, mutationScript, [], true);
        if (writable) {
          expect(mutation.code, mutation.stderr.toString()).toBe(0);
        } else {
          expect(mutation.code).not.toBe(0);
        }
        await expect(fs.readFile(hostSentinel, "utf8")).resolves.toBe(expectedHost);
      } finally {
        if (sandbox) {
          await fixture.remove(sandbox.runtimeId);
        }
      }
    }
  } finally {
    await fixture.close();
  }
}, 120_000);

test("Docker confines subagent attachments to the authorized session", async () => {
  const fixture = await createFixture("attachment", "oc-attachment-qa-");
  const { root } = fixture;
  const workspaceDir = path.join(root, "workspace");
  const attachedSessionKey = `agent:main:subagent:attached-${randomUUID()}`;
  const siblingSessionKey = `agent:main:subagent:sibling-${randomUUID()}`;
  let attachmentId: string | undefined;
  const cleanupAttachments = async () => {
    if (!attachmentId) {
      return;
    }
    const { cleanupMaterializedSubagentAttachments } =
      await import("../../../../src/agents/subagents/spawn/subagent-attachments.js");
    await cleanupMaterializedSubagentAttachments({
      childSessionKey: attachedSessionKey,
      attachmentId,
    });
    attachmentId = undefined;
  };

  await fs.mkdir(workspaceDir, { recursive: true });
  const config = fixture.config("none", "agent");
  config.tools = { sessions_spawn: { attachments: { enabled: true } } };
  setRuntimeConfigSnapshot(config);

  try {
    const [{ materializeSubagentAttachments }, { resolveSubagentSessionAttachmentRootDir }] =
      await Promise.all([
        import("../../../../src/agents/subagents/spawn/subagent-attachments.js"),
        import("../../../../src/agents/subagents/subagent-attachment-paths.js"),
      ]);
    let spawnAuthorityActive = true;
    const materialized = await materializeSubagentAttachments({
      assertActive: () => {
        if (!spawnAuthorityActive) {
          throw new Error("spawn authority closed");
        }
      },
      config,
      childSessionKey: attachedSessionKey,
      targetAgentId: "main",
      sandboxed: true,
      attachments: [{ name: "proof.txt", content: "authorized" }],
    });
    assert(materialized?.status === "ok", "attachment materialization failed");
    attachmentId = materialized.attachmentId;
    // Provisioning and retained reads must not depend on the now-closed parent
    // spawn authority; the session-owned staged identity is the durable grant.
    spawnAuthorityActive = false;

    const attached = await fixture.resolve(config, attachedSessionKey, workspaceDir);
    const sibling = await fixture.resolve(config, siblingSessionKey, workspaceDir);
    expect(attached?.backend).toBeDefined();
    expect(sibling?.backend).toBeDefined();
    expect(attached.runtimeId).not.toBe(sibling.runtimeId);

    const exposedPath = `/openclaw/attachments/${attachmentId}/proof.txt`;
    await expectOk(attached, 'test "$(cat "$1")" = authorized', [exposedPath]);
    await expectOk(attached, 'test "$(cat "$1")" = authorized', [exposedPath]);
    const mutation = await run(attached, 'printf denied > "$1"', [exposedPath], true);
    expect(mutation.code).not.toBe(0);
    const attachmentRoot = resolveSubagentSessionAttachmentRootDir({
      agentId: "main",
      childSessionKey: attachedSessionKey,
    });
    await expect(
      fs.readFile(path.join(attachmentRoot, attachmentId, "proof.txt"), "utf8"),
    ).resolves.toBe("authorized");
    await expectOk(sibling, 'test ! -e "$1"', [exposedPath]);

    for (const sandbox of [attached, sibling]) {
      await fixture.remove(sandbox.runtimeId);
    }
    await cleanupAttachments();
  } finally {
    await fixture.close(true, cleanupAttachments);
  }
}, 120_000);
