import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { prepareLocalSandboxWorkspace } from "../../agents/sandbox/local-workspace.js";
import { initializeGitFixture } from "../../agents/worktrees/git-fixture.test-support.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { getRuntimeConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { pairOperatorDeviceFixture } from "../paired-device.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import * as recoveryOwner from "../worker-environments/local-workspace-recovery.js";
import { readLocalWorkspaceProjection } from "../worker-environments/local-workspace-store.test-support.js";

async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Real paired clients, state/lease owners, and filesystem; no caller-supplied authority callbacks. */
export async function proveWorkspaceRecoveryAuthority(signal: AbortSignal) {
  await withOpenClawTestState(
    {
      label: "workspace-recovery-authority",
      scenario: "minimal",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    },
    async (state) => {
      const lock = await acquireGatewayLock({
        env: state.env,
        allowInTests: true,
        role: "gateway",
      });
      if (!lock) {
        throw new Error("Expected real Gateway state ownership");
      }
      const clients: Array<Awaited<ReturnType<typeof connectGatewayClient>>> = [];
      let server: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        server = await startGatewayWithClient({
          configPath: state.configPath,
          token: "synthetic-recovery-authority-token",
          scopes: ["operator.admin"],
          cfg: {
            worktreeAcceleration: false,
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "synthetic-recovery-authority-token" },
            },
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
              },
            },
            plugins: { enabled: false, slots: { memory: "none" } },
            models: { catalogRefresh: { enabled: false } },
            cron: { enabled: false },
            update: { checkOnStart: false },
          },
        });
        clients.push(server.client);
        await server.server.startupSettled;
        const control = server.client;
        const cfg = getRuntimeConfig();
        const expectedOwnerId = captureGatewayStateOwner(resolveOpenClawStateSqlitePath())?.ownerId;
        expect(expectedOwnerId).toBeTruthy();
        const connectDevice = async (label: string, scopes: string[]) => {
          const { identity, issued: token } = await pairOperatorDeviceFixture({
            identityPath: state.path(label, "client", "credentials.sqlite"),
            scopes,
            tokenScopes: scopes,
            clientId: "test",
            clientMode: "backend",
            callerScopes: ["operator.admin"],
          });
          if (!token.ok) {
            throw new Error("Expected a paired device token");
          }
          const connected = await connectGatewayClient({
            url: "ws://127.0.0.1:" + server!.port,
            mode: "backend",
            deviceIdentity: identity,
            deviceToken: token.entry.token,
            scopes,
          });
          clients.push(connected);
          return { connected, identity };
        };
        const repository = await initializeGitFixture(
          state.root,
          "repository",
          "source.txt",
          "original\n",
        );
        const sessionKey = "agent:main:dashboard:recovery-authority";
        const service = new ManagedWorktreeService({ env: state.env, getConfig: () => cfg });
        const worktree = await service.create({
          repoRoot: repository,
          name: "recovery",
          ownerKind: "session",
          ownerId: sessionKey,
          runSetupScript: false,
        });
        const replacement = await service.create({
          repoRoot: repository,
          name: "replacement",
          ownerKind: "session",
          ownerId: sessionKey + "-replacement",
          runSetupScript: false,
        });
        const binding = { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot };
        const entry = { sessionId: randomUUID(), updatedAt: Date.now(), worktree: binding };
        const session = {
          agentId: "main",
          sessionKey,
          storePath:
            cfg.session?.store ?? state.statePath("agents", "main", "sessions", "sessions.json"),
        };
        await replaceSessionEntry(session, entry);
        const prepare = () =>
          prepareLocalSandboxWorkspace({
            cfg,
            agentId: "main",
            sessionKey,
            workspaceDir: worktree.path,
            sandbox: resolveSandboxConfigForAgent(cfg, "main"),
          });
        const prepared = await prepare();
        if (!prepared) {
          throw new Error("Expected a local sandbox projection");
        }
        const relative = ".openclaw/tmp/oversized.bin";
        const source = path.join(prepared.workspaceDir, relative);
        const recoveryId = randomUUID();
        const destination = path.join(
          await fs.realpath(state.stateDir),
          "workspace-recovery",
          worktree.id,
          recoveryId,
          relative,
        );
        try {
          await fs.mkdir(path.dirname(source), { recursive: true });
          await fs.writeFile(source, "retained recovery authority proof\n");
          await fs.truncate(source, 64 * 1024 * 1024 + 1);
          await fs.writeFile(
            path.join(prepared.workspaceDir, "source.txt"),
            "preserved source edit\n",
          );
          await expect(prepared.checkpoint()).rejects.toThrow("result is too large");
        } finally {
          prepared[Symbol.dispose]();
        }
        const originalHash = await digest(source);
        const pending = (await readLocalWorkspaceProjection(worktree.id))!.pending_ref;
        const params = { sessionKey, path: relative, recoveryId, expectedOwnerId };
        const unchanged = async () => {
          expect(await digest(source)).toBe(originalHash);
          await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readFile(path.join(prepared.workspaceDir, "source.txt"), "utf8")).toBe(
            "preserved source edit\n",
          );
          expect((await readLocalWorkspaceProjection(worktree.id))!.pending_ref).toBe(pending);
        };
        let gate:
          | {
              entered: ReturnType<typeof createDeferred<void>>;
              release: ReturnType<typeof createDeferred<void>>;
            }
          | undefined;
        let moveCount = 0;
        const realRoot = fsSafe.root;
        // Pause the actual source-file open after it succeeds. All subsequent checks,
        // mkdir/move operations, and their final-effect authority remain production code.
        vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
          const root = await realRoot(...args);
          const open = root.open.bind(root);
          vi.spyOn(root, "open").mockImplementation(async (...openArgs) => {
            const file = await open(...openArgs);
            if (path.resolve(root.rootReal, openArgs[0]) === source && gate) {
              gate.entered.resolve();
              await gate.release.promise;
            }
            return file;
          });
          const move = root.move.bind(root);
          vi.spyOn(root, "move").mockImplementation(async (...moveArgs) => {
            moveCount += 1;
            return await move(...moveArgs);
          });
          return root;
        });
        const writer = await connectDevice("writer", ["operator.write"]);
        await unchanged();
        await expect(writer.connected.request("worktrees.recoverFile", params)).rejects.toThrow(
          "missing scope: operator.admin",
        );
        await unchanged();
        expect(moveCount).toBe(0);
        console.info(
          "Recovery authority: write-only denied; original hash/pending edits unchanged; destination absent; moves=0",
        );
        const revoked = await connectDevice("revoked-admin", ["operator.admin"]);
        for (const change of [
          "requester-revoked",
          "session-replaced",
          "worktree-rebound",
        ] as const) {
          const finished = createDeferred<unknown>();
          gate = { entered: createDeferred(), release: createDeferred() };
          const selectedGate = gate;
          const recover = recoveryOwner.recoverLocalWorkspaceFile;
          const observed = vi
            .spyOn(recoveryOwner, "recoverLocalWorkspaceFile")
            .mockImplementationOnce(async (input) => {
              try {
                const value = await recover(input);
                finished.resolve(value);
                return value;
              } catch (error) {
                finished.resolve(error);
                throw error;
              }
            });
          const requestingClient = change === "requester-revoked" ? revoked.connected : control;
          const reply = requestingClient.request("worktrees.recoverFile", params).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                selectedGate.entered.promise,
                finished.promise.then((outcome) => {
                  if (outcome instanceof Error) {
                    throw outcome;
                  }
                }),
                "Recovery settled before source-open barrier",
              ),
              signal,
            );
            await unchanged();
            if (change === "requester-revoked") {
              await control.request("device.token.revoke", {
                deviceId: revoked.identity.deviceId,
                role: "operator",
              });
            } else {
              await replaceSessionEntry(
                session,
                change === "session-replaced"
                  ? { ...entry, sessionId: randomUUID() }
                  : {
                      ...entry,
                      worktree: {
                        id: replacement.id,
                        branch: replacement.branch,
                        repoRoot: replacement.repoRoot,
                      },
                    },
              );
            }
            selectedGate.release.resolve();
            const failure = await withinTest(finished.promise, signal);
            expect(failure).toBeInstanceOf(Error);
            expect(String(failure)).toMatch(/authority|revok|abort|changed/iu);
            expect(await withinTest(reply, signal)).toHaveProperty("error");
            await unchanged();
            expect(moveCount).toBe(0);
            console.info(
              "Recovery authority: " +
                change +
                " during source open denied; original hash/pending edits unchanged; destination absent; moves=0",
            );
          } finally {
            selectedGate.release.resolve();
            await withinTest(Promise.all([finished.promise, reply]), signal);
            observed.mockRestore();
            gate = undefined;
            await replaceSessionEntry(session, entry);
          }
        }
        const allowed = await control.request<{ path: string; bytes: number }>(
          "worktrees.recoverFile",
          params,
        );
        expect(allowed).toEqual({ path: destination, bytes: 64 * 1024 * 1024 + 1 });
        await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await digest(destination)).toBe(originalHash);
        expect(moveCount).toBe(1);
        expect(await fs.readFile(path.join(prepared.workspaceDir, "source.txt"), "utf8")).toBe(
          "preserved source edit\n",
        );
        console.info(
          "Recovery authority: current administrator allowed; retained hash unchanged; source edit preserved; moves=1",
        );
      } finally {
        vi.restoreAllMocks();
        for (const client of clients) {
          await disconnectGatewayClient(client);
        }
        await server?.server.close({ reason: "workspace recovery authority proof complete" });
        await lock.release();
      }
    },
  );
}
