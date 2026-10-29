import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workspaceStore from "./local-workspace-store.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const command = () => ({ command: "true", env: {}, usePty: false });
const failedOutcome = { status: "failed" as const, exitCode: 0, timedOut: false };
const authorityChanged = "Local sandbox workspace authority changed";
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

async function registerWorkspace(owner: LocalWorkspaceOwner, guestProfileId?: string) {
  await insertRegistryWorktree(process.env, owner.worktree);
  const scope = { agentId: owner.agentId, sessionKey: owner.sessionKey };
  const { id, branch, repoRoot } = owner.worktree;
  const entry = {
    sessionId: owner.sessionId,
    updatedAt: 1,
    worktree: { id, branch, repoRoot },
    ...(guestProfileId
      ? buildSessionCreationStamp({
          via: "operator",
          actor: { type: "human", source: "profile", id: guestProfileId },
          sandbox: "required",
          now: 1,
        })
      : {}),
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
            void capture(...args);
            const result = await store.manifest(...args);
            const afterScan = afterCapture;
            afterCapture = undefined;
            await afterScan?.();
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
    await expect(projection.checkpoint()).rejects.toThrow(authorityChanged);
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
  await expect(projection.checkpoint()).rejects.toThrow(authorityChanged);
}

export async function proveStoppedSandboxAuthority(
  owner: LocalWorkspaceOwner,
  revoke: "operator" | "gateway" | "guest-involvement",
  testSignal?: AbortSignal,
) {
  const [state, lease, paths, users, roles, auth, server, cfg, workspaces, backends] =
    await Promise.all([
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
      const guestInvolvement = revoke === "guest-involvement";
      const guestScopes: GatewayOperatorRoleDefinition["scopes"] = [
        "operator.sessions.read",
        "operator.sessions.write",
      ];
      const guestRole: GatewayOperatorRoleDefinition = {
        scopes: guestScopes,
        agents: "*",
        sessions: { others: "none" },
        sandbox: "required",
      };
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
            default: guestInvolvement ? "guest" : "writer",
            definitions: {
              ...(guestInvolvement ? { guest: guestRole } : {}),
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
      cfg.setRuntimeConfigSnapshot(config);
      const profile = await users.ensureCanonicalUserProfileForEmail(
        guestInvolvement ? "checkpoint-guest@example.test" : "checkpoint-operator@example.test",
      );
      await users.setCanonicalUserProfileRole(profile.id, guestInvolvement ? "guest" : "writer");
      const context = server.createContext();
      context.getRuntimeConfig = () => config;
      const captured = await auth.captureGatewayOperatorRunAuthority({
        client: server.createOperatorClient({
          profileId: profile.id,
          scopes: guestInvolvement ? guestScopes : ["operator.write"],
        }),
        context,
      });
      assert(captured?.authority.retain, "Expected retained operator authority");
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
      const shell = guestInvolvement ? vi.spyOn(backend, "runShellCommand") : undefined;
      // Substitute container execution only; the authority and checkpoint owners stay real.
      const provision = vi.spyOn(backends, "createSandboxBackend").mockResolvedValue(backend);
      try {
        const { scope } = await registerWorkspace(owner, guestInvolvement ? profile.id : undefined);
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
        if (guestInvolvement) {
          assert(testSignal && shell, "Expected guest receipt proof lifetime");
          expect(captured.authority.scopes).toEqual(guestScopes);
          expect(captured.authority.rolePolicy?.sandboxRequired).toBe(true);
          expect(loadSessionEntry(scope)).toMatchObject({
            createdActor: { type: "human", source: "profile", id: profile.id },
            sandbox: "required",
          });
          const accepted = await backend.buildExecSpec(command());
          await writeSource(sandbox.workspaceDir, "accepted guest edit\n");
          await finish(backend, accepted.finalizeToken);
          await expectSource(owner.worktree.path, "accepted guest edit\n");

          const [receipts, agentWorkers, involvement] = await Promise.all([
            import("../../infra/sqlite-worker-operation-admission.js"),
            import("../../state/openclaw-agent-worker-store.js"),
            import("../../config/sessions/session-involvement-store.js"),
          ]);
          const receiptReached = createDeferred();
          const resultReached = createDeferred();
          const releaseResult = createDeferred();
          let deliver: (() => void) | undefined;
          let closing = false;
          let receiptCount = 0;
          let dispatches = 0;
          const deliverReceipt = () => {
            const publish = deliver;
            deliver = undefined;
            publish?.();
          };
          const observe = receipts.observeSqliteWorkerCommittedFacts;
          const observeReceipt = vi
            .spyOn(receipts, "observeSqliteWorkerCommittedFacts")
            .mockImplementation((native, publish) =>
              observe(native, (receipt) => {
                if (
                  !closing &&
                  isRecord(receipt.facts) &&
                  receipt.facts.kind === "session-collaboration-committed" &&
                  receipt.facts.type === "involvement"
                ) {
                  receiptCount++;
                  // Delay only delivery; native COMMIT and its receipt remain untouched.
                  deliver = () => publish(receipt);
                  receiptReached.resolve();
                } else {
                  publish(receipt);
                }
              }),
            );
          const original = agentWorkers.openOpenClawAgentSqliteWorkerStore;
          const open = vi
            .spyOn(agentWorkers, "openOpenClawAgentSqliteWorkerStore")
            .mockImplementation(
              async <Operations extends SqliteWorkerOperations>(
                ...args: Parameters<typeof original>
              ) => {
                const worker = await original<Operations>(...args);
                return {
                  ...worker,
                  run<T>(
                    consume: (
                      operation: Pick<SqliteWorkerStore<Operations>, "execute">,
                    ) => Promise<T>,
                    assertCurrent: () => void,
                  ) {
                    return worker.run(
                      (operation) =>
                        consume({
                          async execute(workerCommand, options) {
                            if (workerCommand.type === "involvement") {
                              dispatches++;
                            }
                            const result = await operation.execute(workerCommand, options);
                            if (workerCommand.type === "involvement") {
                              resultReached.resolve();
                              await releaseResult.promise;
                            }
                            return result;
                          },
                        }),
                      assertCurrent,
                    );
                  },
                };
              },
            );
          const mutation = involvement.updateSessionProfileInvolvementAsync(scope, {
            expectedSessionId: owner.sessionId,
            profileIds: [profile.id],
            change: { kind: "visibility", hidden: true },
            assertCurrent: captured.authority.assertCurrent,
          });
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                Promise.all([receiptReached.promise, resultReached.promise]),
                mutation,
                "Involvement settled before its native receipt was delayed",
              ),
              testSignal,
            );
            captured.authority.assertCurrent();
            await users.setCanonicalUserProfileRole(profile.id, "denied", {
              onCommitted: roles.invalidateOperatorRolePolicy,
            });
            deliverReceipt();
            releaseResult.resolve();
            await expect(mutation).resolves.toBe(true);
            expect(receiptCount).toBe(1);
            expect(dispatches).toBe(1);
            expect(loadSessionEntry(scope)?.profileInvolvement?.profiles[profile.id]?.hidden).toBe(
              true,
            );
            // No Stop, run close or workspace disposal can account for this denial.
            expect(controller.signal.aborted).toBe(false);
            await expect(
              sandbox.fsBridge.writeFile({ filePath: "revoked.txt", data: "must not write" }),
            ).rejects.toMatchObject({
              message: "admitted run authority is no longer active",
              cause: expect.objectContaining({
                message: expect.stringMatching(/operator|source execution authority/),
              }),
            });
            expect(shell).not.toHaveBeenCalled();
            for (const directory of [sandbox.workspaceDir, owner.worktree.path]) {
              await expect(fs.stat(path.join(directory, "revoked.txt"))).rejects.toMatchObject({
                code: "ENOENT",
              });
            }
            await expectSource(owner.worktree.path, "accepted guest edit\n");
          } finally {
            closing = true;
            try {
              deliverReceipt();
            } finally {
              releaseResult.resolve();
              await mutation.catch(() => {});
              open.mockRestore();
              observeReceipt.mockRestore();
            }
          }
          return;
        }
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
        if (revoke === "operator") {
          await users.setCanonicalUserProfileRole(profile.id, "denied", {
            onCommitted: roles.invalidateOperatorRolePolicy,
          });
          expect(captured.authority.assertCurrent).toThrow();
          await expect(finish(backend, pending.finalizeToken)).rejects.toThrow(
            /operator|source execution authority/,
          );
        } else {
          gateway.release();
          await expect(finish(backend, pending.finalizeToken)).rejects.toMatchObject({
            code: "GATEWAY_STATE_OWNER_REQUIRED",
          });
        }
        await expectSource(owner.worktree.path, "accepted guest edit\n");
      } finally {
        shell?.mockRestore();
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
