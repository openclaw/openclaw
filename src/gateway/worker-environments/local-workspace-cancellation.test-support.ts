import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import type { SandboxBackendHandle } from "../../agents/sandbox/backend-handle.types.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { createSandboxFsBridge } from "../../agents/sandbox/fs-bridge.js";
import {
  bindLocalSandboxWorkspace,
  prepareLocalSandboxWorkspace,
} from "../../agents/sandbox/local-workspace.js";
import { createSandboxTestContext } from "../../agents/sandbox/test-fixtures.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

export async function proveStoppedLocalWorkspaceCheckpoint(
  owner: LocalWorkspaceOwner,
  disposeBeforeCheckpoint = false,
) {
  await insertRegistryWorktree(process.env, owner.worktree);
  const sessionScope = { agentId: owner.agentId, sessionKey: owner.sessionKey };
  const entry = {
    sessionId: owner.sessionId,
    updatedAt: 1,
    worktree: {
      id: owner.worktree.id,
      branch: owner.worktree.branch,
      repoRoot: owner.worktree.repoRoot,
    },
  };
  await replaceSessionEntry(sessionScope, entry);
  const controller = new AbortController();
  let hostCurrent = true;
  using projection = await prepareLocalSandboxWorkspace({
    cfg: { worktreeAcceleration: false },
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    workspaceDir: owner.worktree.path,
    sandbox: resolveSandboxConfigForAgent({}, owner.agentId),
    assertCurrent: () => controller.signal.throwIfAborted(),
    assertHost: () => {
      if (!hostCurrent) {
        throw new Error("Gateway owner closed");
      }
    },
  });
  if (!projection) {
    throw new Error("Expected managed projection");
  }
  const backend: SandboxBackendHandle = {
    id: "docker",
    runtimeId: "stopped-command",
    runtimeLabel: "stopped-command",
    workdir: "/workspace",
    buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
    runShellCommand: async () => {
      throw new Error("New shell work must remain blocked");
    },
  };
  const sandbox = createSandboxTestContext({
    overrides: { workspaceDir: projection.workspaceDir, backend },
  });
  sandbox.fsBridge = createSandboxFsBridge({ sandbox: { ...sandbox, backend } });
  bindLocalSandboxWorkspace(sandbox, projection);
  const spec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
  const laterSpec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
  await fs.writeFile(path.join(projection.workspaceDir, "source.txt"), "stopped guest edit\n");
  const reason = createAgentRunDirectAbortError();
  controller.abort(reason);
  if (disposeBeforeCheckpoint) {
    projection[Symbol.dispose]();
  }
  const outcome = {
    status: "failed" as const,
    exitCode: 0,
    timedOut: false,
    token: spec.finalizeToken,
  };
  await expect(backend.finalizeExec!(outcome)).resolves.toBeUndefined();
  expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
    "stopped guest edit\n",
  );
  await expect(backend.runShellCommand({ script: "true" })).rejects.toBe(reason);
  await expect(backend.buildExecSpec({ command: "true", env: {}, usePty: false })).rejects.toBe(
    reason,
  );
  await expect(
    sandbox.fsBridge.writeFile({ filePath: "late.txt", data: "must not write" }),
  ).rejects.toBe(reason);
  await expect(fs.stat(path.join(projection.workspaceDir, "late.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  if (disposeBeforeCheckpoint) {
    await fs.writeFile(
      path.join(projection.workspaceDir, "source.txt"),
      "last stopped guest edit\n",
    );
    await backend.finalizeExec!({ ...outcome, token: laterSpec.finalizeToken });
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "last stopped guest edit\n",
    );
    await expect(projection.checkpoint()).rejects.toThrow(
      "Local sandbox workspace authority changed",
    );
    return;
  }
  hostCurrent = false;
  await expect(projection.checkpoint()).rejects.toThrow("Gateway owner closed");
  hostCurrent = true;
  await fs.writeFile(path.join(projection.workspaceDir, "source.txt"), "guest conflict\n");
  await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "human conflict\n");
  await expect(
    backend.finalizeExec!({ ...outcome, token: laterSpec.finalizeToken }),
  ).rejects.toThrow("conflict");
  await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "stopped guest edit\n");
  await projection.checkpoint();
  await replaceSessionEntry(sessionScope, { ...entry, sessionId: randomUUID(), updatedAt: 2 });
  await expect(projection.checkpoint()).rejects.toThrow(
    "Local sandbox workspace authority changed",
  );
}

export async function proveStoppedSandboxAuthority(
  owner: LocalWorkspaceOwner,
  revoke: "operator" | "gateway",
) {
  const [
    { withOpenClawTestState },
    { acquireGatewayStateOwner },
    { resolveOpenClawStateSqlitePath },
    { ensureCanonicalUserProfileForEmail, setCanonicalUserProfileRole },
    { invalidateOperatorRolePolicy },
    { captureGatewayOperatorRunAuthority },
    { createContext, createOperatorClient },
    { setRuntimeConfigSnapshot },
    { resolveAttemptWorkspaceSandbox },
    backendModule,
  ] = await Promise.all([
    import("../../test-utils/openclaw-test-state.js"),
    import("../../infra/gateway-state-owner.js"),
    import("../../state/openclaw-state-db.paths.js"),
    import("../../state/user-profile-writes.js"),
    import("../operator-role-policy.js"),
    import("../operator-run-authority.js"),
    import("../server-plugin-in-process-dispatch.test-support.js"),
    import("../../config/runtime-snapshot.js"),
    import("../../agents/workspace-sandbox.js"),
    import("../../agents/sandbox/backend.js"),
  ]);
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const gateway = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: state.configPath,
        role: "gateway",
      },
    });
    try {
      const config: import("../../config/types.openclaw.js").OpenClawConfig = {
        worktreeAcceleration: false,
        agents: {
          defaults: {
            workspace: owner.worktree.path,
            skipBootstrap: true,
            sandbox: {
              mode: "all",
              scope: "session",
              workspaceAccess: "rw",
              docker: { user: "0:0" },
              browser: { enabled: false },
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
        skills: { load: { watch: false } },
        gateway: {
          roles: {
            default: "writer",
            definitions: {
              writer: {
                scopes: ["operator.read", "operator.write"],
                agents: "*",
                sessions: { others: "none" },
              },
              denied: { scopes: [], agents: [], sessions: { others: "none" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      const profile = await ensureCanonicalUserProfileForEmail("checkpoint-operator@example.test");
      await setCanonicalUserProfileRole(profile.id, "writer");
      const context = createContext();
      context.getRuntimeConfig = () => config;
      const captured = await captureGatewayOperatorRunAuthority({
        client: createOperatorClient({ profileId: profile.id, scopes: ["operator.write"] }),
        context,
      });
      if (!captured?.authority.retain) {
        throw new Error("Expected retained operator authority");
      }
      const releaseOperator = captured.authority.retain();
      const admission = prepareSystemAgentRunAdmission(
        config,
        randomUUID(),
        owner.agentId,
        "workspace-checkpoint-test",
        undefined,
        captured.authority,
      );
      const backend: SandboxBackendHandle = {
        id: "docker",
        runtimeId: "authority-command",
        runtimeLabel: "authority-command",
        workdir: "/workspace",
        buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
        runShellCommand: async () => {
          throw new Error("New shell work must remain blocked");
        },
      };
      // Substitute container execution only; the authority and checkpoint owners stay real.
      const provision = vi.spyOn(backendModule, "createSandboxBackend").mockResolvedValue(backend);
      try {
        await insertRegistryWorktree(process.env, owner.worktree);
        await replaceSessionEntry(
          { agentId: owner.agentId, sessionKey: owner.sessionKey },
          {
            sessionId: owner.sessionId,
            updatedAt: 1,
            worktree: {
              id: owner.worktree.id,
              branch: owner.worktree.branch,
              repoRoot: owner.worktree.repoRoot,
            },
          },
        );
        const controller = new AbortController();
        using workspace = await resolveAttemptWorkspaceSandbox({
          config,
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          sessionId: owner.sessionId,
          workspaceDir: owner.worktree.path,
          abortSignal: controller.signal,
          admittedRunContext: await admission.admit("embedded"),
        });
        const sandbox = workspace.sandbox;
        if (!sandbox?.backend || !sandbox.fsBridge) {
          throw new Error("Expected managed sandbox");
        }
        expect(sandbox.workspaceSource).toBe("managed-worktree");
        const accepted = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
        const pending = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
        await fs.writeFile(path.join(sandbox.workspaceDir, "source.txt"), "accepted guest edit\n");
        const reason = createAgentRunDirectAbortError();
        controller.abort(reason);
        admission.close();
        captured.release();
        workspace[Symbol.dispose]();
        const outcome = { status: "failed" as const, exitCode: 0, timedOut: false };
        await backend.finalizeExec!({ ...outcome, token: accepted.finalizeToken });
        expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
          "accepted guest edit\n",
        );
        await expect(
          backend.buildExecSpec({ command: "true", env: {}, usePty: false }),
        ).rejects.toBe(reason);
        await fs.writeFile(path.join(sandbox.workspaceDir, "source.txt"), "revoked guest edit\n");
        if (revoke === "operator") {
          await setCanonicalUserProfileRole(profile.id, "denied", {
            onCommitted: invalidateOperatorRolePolicy,
          });
          expect(captured.authority.assertCurrent).toThrow();
          await expect(
            backend.finalizeExec!({ ...outcome, token: pending.finalizeToken }),
          ).rejects.toThrow(/operator|source execution authority/);
        } else {
          gateway.release();
          await expect(
            backend.finalizeExec!({ ...outcome, token: pending.finalizeToken }),
          ).rejects.toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
        }
        expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
          "accepted guest edit\n",
        );
      } finally {
        provision.mockRestore();
        admission.close();
        captured.release();
        releaseOperator();
      }
    } finally {
      gateway.release();
    }
  });
}
