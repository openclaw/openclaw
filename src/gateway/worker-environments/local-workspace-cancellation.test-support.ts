import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
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
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import * as workspaceStore from "./local-workspace-store.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const command = () => ({ command: "true", env: {}, usePty: false });
const failedOutcome = { status: "failed" as const, exitCode: 0, timedOut: false };
const workspaceChanged = /Local sandbox workspace (changed|was released)/;
const writeSource = (dir: string, data: string) => fs.writeFile(path.join(dir, "source.txt"), data);
const expectSource = async (dir: string, data: string) =>
  expect(await fs.readFile(path.join(dir, "source.txt"), "utf8")).toBe(data);
const finish = (backend: SandboxBackendHandle, token: unknown) =>
  backend.finalizeExec!({ ...failedOutcome, token });

function createBackend(runtimeId: string): SandboxBackendHandle {
  return {
    id: "docker",
    runtimeId,
    runtimeLabel: runtimeId,
    workdir: "/workspace",
    buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
    runShellCommand: async () => {
      throw new Error("New shell work must remain blocked");
    },
  };
}

async function registerWorkspace(owner: LocalWorkspaceOwner) {
  await insertRegistryWorktree(process.env, owner.worktree);
  const scope = { agentId: owner.agentId, sessionKey: owner.sessionKey };
  const { id, branch, repoRoot } = owner.worktree;
  const entry = {
    sessionId: owner.sessionId,
    updatedAt: 1,
    worktree: { id, branch, repoRoot },
  };
  await replaceSessionEntry(scope, entry);
  return { scope, entry };
}

async function proveQueuedLocalWorkspaceCheckpoint(
  owner: LocalWorkspaceOwner,
  projection: NonNullable<Awaited<ReturnType<typeof prepareLocalSandboxWorkspace>>>,
) {
  await writeSource(projection.workspaceDir, "first edit\n");
  const acquired = createDeferred();
  const release = createDeferred();
  const custody = withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async () => {
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  const withStore = workspaceStore.withLocalWorkspaceStore;
  const capture = vi.fn<workspaceStore.LocalWorkspaceStore["manifest"]>();
  let afterCapture: (() => Promise<void>) | undefined;
  const spy = vi
    .spyOn(workspaceStore, "withLocalWorkspaceStore")
    .mockImplementation((params, run) =>
      withStore(params, (store) =>
        run({
          ...store,
          manifest: async (...args) => {
            const result = await store.manifest(...args);
            if (result.kind === "scan" && !(args[1].kind === "scan" && args[1].prehash)) {
              void capture(...args);
              const afterScan = afterCapture;
              afterCapture = undefined;
              await afterScan?.();
            }
            return result;
          },
        }),
      ),
    );
  const first = projection.checkpoint();
  const second = projection.checkpoint();
  release.resolve();
  await Promise.all([custody, first, second]);
  await expectSource(owner.worktree.path, "first edit\n");
  expect(capture).toHaveBeenCalledOnce();

  const captured = createDeferred();
  const finishCapture = createDeferred();
  afterCapture = async () => {
    captured.resolve();
    await finishCapture.promise;
  };
  const third = projection.checkpoint();
  await captured.promise;
  const later = projection.checkpoint();
  finishCapture.resolve();
  await Promise.all([third, later]);
  expect(capture).toHaveBeenCalledTimes(3);

  spy.mockRestore();
}

export async function proveStoppedLocalWorkspaceCheckpoint(
  owner: LocalWorkspaceOwner,
  disposeBeforeCheckpoint = false,
) {
  const { scope, entry } = await registerWorkspace(owner);
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
  assert(projection, "Expected managed projection");
  if (!disposeBeforeCheckpoint) {
    await proveQueuedLocalWorkspaceCheckpoint(owner, projection);
  }
  const backend = createBackend("stopped-command");
  const sandbox = createSandboxTestContext({
    overrides: { workspaceDir: projection.workspaceDir, backend },
  });
  sandbox.fsBridge = createSandboxFsBridge({ sandbox: { ...sandbox, backend } });
  bindLocalSandboxWorkspace(sandbox, projection);
  const spec = await backend.buildExecSpec(command());
  const laterSpec = await backend.buildExecSpec(command());
  await writeSource(projection.workspaceDir, "stopped guest edit\n");
  const reason = createAgentRunDirectAbortError();
  controller.abort(reason);
  if (disposeBeforeCheckpoint) {
    projection[Symbol.dispose]();
  }
  await expect(finish(backend, spec.finalizeToken)).resolves.toBeUndefined();
  await expectSource(owner.worktree.path, "stopped guest edit\n");
  await expect(backend.runShellCommand({ script: "true" })).rejects.toBe(reason);
  await expect(backend.buildExecSpec(command())).rejects.toBe(reason);
  await expect(
    sandbox.fsBridge.writeFile({ filePath: "late.txt", data: "must not write" }),
  ).rejects.toBe(reason);
  await expect(fs.stat(path.join(projection.workspaceDir, "late.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  if (disposeBeforeCheckpoint) {
    await writeSource(projection.workspaceDir, "last stopped guest edit\n");
    await finish(backend, laterSpec.finalizeToken);
    await expectSource(owner.worktree.path, "last stopped guest edit\n");
    await expect(projection.checkpoint()).rejects.toThrow(workspaceChanged);
    return;
  }
  hostCurrent = false;
  await expect(projection.checkpoint()).rejects.toThrow("Gateway owner closed");
  hostCurrent = true;
  await writeSource(projection.workspaceDir, "guest conflict\n");
  await writeSource(owner.worktree.path, "human conflict\n");
  await expect(finish(backend, laterSpec.finalizeToken)).rejects.toThrow("conflict");
  await writeSource(owner.worktree.path, "stopped guest edit\n");
  await projection.checkpoint();
  await replaceSessionEntry(scope, { ...entry, sessionId: randomUUID(), updatedAt: 2 });
  await expect(projection.checkpoint()).rejects.toThrow(workspaceChanged);
}

export async function proveStoppedSandboxAuthority(
  owner: LocalWorkspaceOwner,
  revoke: "gateway" | "prepare-release" | "prepare-cancel",
  testSignal?: AbortSignal,
) {
  const [state, lease, paths, users, auth, server, cfg, workspaces, backends] = await Promise.all([
    import("../../test-utils/openclaw-test-state.js"),
    import("../../infra/gateway-state-owner.js"),
    import("../../state/openclaw-state-db.paths.js"),
    import("../../state/user-profile-writes.js"),
    import("../operator-run-authority.js"),
    import("../server-plugin-in-process-dispatch.test-support.js"),
    import("../../config/runtime-snapshot.js"),
    import("../../agents/workspace-sandbox.js"),
    import("../../agents/sandbox/backend.js"),
  ]);
  await state.withOpenClawTestState({ scenario: "minimal" }, async ({ configPath }) => {
    const gateway = lease.acquireGatewayStateOwner({
      databasePath: paths.resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath,
        role: "gateway",
        processNamespace: readGatewayLockProcessNamespace(),
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
            },
          },
        },
      };
      cfg.setRuntimeConfigSnapshot(config);
      const profile = await users.ensureCanonicalUserProfileForEmail(
        "checkpoint-operator@example.test",
      );
      await users.setCanonicalUserProfileRole(profile.id, "writer");
      const context = server.createContext();
      context.getRuntimeConfig = () => config;
      const captured = await auth.prepareGatewayOperatorRunAuthority({
        client: server.createOperatorClient({
          profileId: profile.id,
          scopes: ["operator.write"],
        }),
        context,
      });
      assert(captured, "Expected admitted operator request");
      assert(captured.authority.retain, "Expected retained operator authority");
      const releaseOperator = captured.authority.retain();
      const admission = prepareSystemAgentRunAdmission(
        config,
        randomUUID(),
        owner.agentId,
        "workspace-checkpoint-test",
        undefined,
        captured.authority,
      );
      const backend = createBackend("authority-command");
      // Substitute container execution only; the authority and checkpoint owners stay real.
      const provision = vi
        .spyOn(backends, "createSandboxBackend")
        .mockImplementation(async (params) => {
          backend.workdir = params.workspaceDir;
          return backend;
        });
      try {
        await registerWorkspace(owner);
        if (revoke === "prepare-release" || revoke === "prepare-cancel") {
          assert(testSignal, "Expected preparation proof lifetime");
          await proveAttemptPreparationWhileLeaseHeld(
            owner,
            revoke === "prepare-release" ? "release" : "cancel",
            testSignal,
            async (controller) => {
              const prepared = await workspaces.resolveAttemptWorkspaceSandbox({
                config,
                agentId: owner.agentId,
                sessionKey: owner.sessionKey,
                sessionId: owner.sessionId,
                workspaceDir: owner.worktree.path,
                abortSignal: controller.signal,
                admittedRunContext: await admission.admit("embedded"),
              });
              return {
                workspaceDir: prepared.effectiveWorkspace,
                [Symbol.dispose]: () => prepared[Symbol.dispose](),
              };
            },
          );
          return;
        }
        const controller = new AbortController();
        using workspace = await workspaces.resolveAttemptWorkspaceSandbox({
          config,
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          sessionId: owner.sessionId,
          workspaceDir: owner.worktree.path,
          abortSignal: controller.signal,
          admittedRunContext: await admission.admit("embedded"),
        });
        const sandbox = workspace.sandbox;
        assert(sandbox?.backend && sandbox.fsBridge, "Expected managed sandbox");
        expect(sandbox.workspaceSource).toBe("managed-worktree");
        const accepted = await backend.buildExecSpec(command());
        const pending = await backend.buildExecSpec(command());
        await writeSource(sandbox.workspaceDir, "accepted guest edit\n");
        const reason = createAgentRunDirectAbortError();
        controller.abort(reason);
        admission.close();
        captured.release();
        workspace[Symbol.dispose]();
        await finish(backend, accepted.finalizeToken);
        await expectSource(owner.worktree.path, "accepted guest edit\n");
        await expect(backend.buildExecSpec(command())).rejects.toBe(reason);
        await writeSource(sandbox.workspaceDir, "revoked guest edit\n");
        gateway.release();
        await expect(finish(backend, pending.finalizeToken)).rejects.toMatchObject({
          code: "GATEWAY_STATE_OWNER_REQUIRED",
        });
        await expectSource(owner.worktree.path, "accepted guest edit\n");
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

/** Observe workspace admission without replacing the lease or preparation owner. */
async function proveAttemptPreparationWhileLeaseHeld(
  owner: LocalWorkspaceOwner,
  ending: "release" | "cancel",
  testSignal: AbortSignal,
  prepareAttempt: (
    controller: AbortController,
  ) => Promise<{ workspaceDir: string; [Symbol.dispose](): void }>,
) {
  const prepare = (controller: AbortController) =>
    prepareLocalSandboxWorkspace({
      cfg: { worktreeAcceleration: false },
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      workspaceDir: owner.worktree.path,
      sandbox: resolveSandboxConfigForAgent({}, owner.agentId),
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
      assertHost: owner.assertCurrent,
    });
  const seed = await prepare(new AbortController());
  assert(seed, "Registered fixture did not prepare its managed projection");
  const projectionPath = seed.workspaceDir;
  seed[Symbol.dispose]();
  const controller = new AbortController();
  const reason = createAgentRunDirectAbortError();
  const entered = createDeferred();
  const release = createDeferred();
  const waited = createDeferred();
  const withStore = workspaceStore.withLocalWorkspaceStore;
  const admission = vi.spyOn(workspaceStore, "withLocalWorkspaceStore");
  type PreparationOutcome =
    | { kind: "returned"; value: Awaited<ReturnType<typeof prepareAttempt>> }
    | { kind: "rejected"; error: unknown };
  let holder: Promise<void> | undefined;
  let preparation: Promise<PreparationOutcome> | undefined;
  let holderOutcome:
    | Promise<{ kind: "returned" } | { kind: "rejected"; error: unknown }>
    | undefined;
  let beforeRelease: PreparationOutcome | undefined;
  let afterRelease: PreparationOutcome | undefined;
  let afterHolder: Awaited<NonNullable<typeof holderOutcome>> | undefined;
  try {
    holder = withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
      entered.resolve();
      await release.promise;
      store.assertCurrent();
    });
    holderOutcome = holder.then(
      () => ({ kind: "returned" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, holder, "Holder settled before acquiring custody"),
      testSignal,
    );
    admission.mockImplementation((params, run) => {
      const pending = withStore(params, run);
      if (params.worktreeId === owner.worktree.id) {
        waited.resolve();
      }
      return pending;
    });
    preparation = prepareAttempt(controller).then(
      (value) => ({ kind: "returned" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await withinTest(
      awaitGateBeforeSettlement(
        waited.promise,
        preparation,
        "Preparation settled before workspace admission",
      ),
      testSignal,
    );
    if (ending === "cancel") {
      controller.abort(reason);
      beforeRelease = await withinTest(preparation, testSignal);
    }
  } finally {
    // Release first, then join both owners even when observation/test cancellation fails.
    release.resolve();
    try {
      [afterHolder, afterRelease] = await Promise.all([holderOutcome, preparation]);
      if (afterRelease?.kind === "returned") {
        afterRelease.value?.[Symbol.dispose]();
      }
    } finally {
      admission.mockRestore();
    }
  }
  expect(afterHolder?.kind).toBe("returned");
  await expectSource(owner.worktree.path, "original\n");
  await expectSource(projectionPath, "original\n");
  if (ending === "release") {
    expect(afterRelease?.kind).toBe("returned");
    if (afterRelease?.kind === "returned") {
      expect(afterRelease.value?.workspaceDir).toBe(projectionPath);
    }
  } else {
    expect(afterRelease?.kind).toBe("rejected");
    if (afterRelease?.kind === "rejected") {
      expect(afterRelease.error).toMatchObject({ code: "sandbox_provisioning" });
      expect(collectNestedErrorCandidates(afterRelease.error)).toContain(reason);
    }
    expect(beforeRelease?.kind).toBe("rejected");
  }
}
