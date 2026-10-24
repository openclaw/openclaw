import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
} from "../../agents/session-placement-admission.js";
import { saveMediaBuffer } from "../../media/store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { placementTurnOwner } from "./placement-record.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  installLauncherTest,
  remoteExecEnvironment,
  revocableTurn,
} from "./worker-turn-launcher-flow.test-support.js";
import {
  MANIFEST_REF,
  SESSION_ID,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
} from "./worker-turn-launcher.test-support.js";
import { WORKER_ATTACHMENT_DIRECTORY_PREFIX } from "./workspace-path-exclusions.js";

describe("reconciliation continuation authority", () => {
  installLauncherTest();
  it.each([
    { mode: "remote-exec", authority: "source", revokeAt: "wait" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "wait" },
    { mode: "worker-turn", authority: "source", revokeAt: "wait" },
    { mode: "worker-turn", authority: "admitted", revokeAt: "wait" },
    { mode: "remote-exec", authority: "source", revokeAt: "workspace" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "workspace" },
    { mode: "remote-exec", authority: "source", revokeAt: "tunnel" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "tunnel" },
    { mode: "remote-exec", authority: "source", revokeAt: "dispatch" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "dispatch" },
    { mode: "remote-exec", authority: "source", revokeAt: "init" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "init" },
    { mode: "remote-exec", authority: "source", revokeAt: "write" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "write" },
    { mode: "remote-exec", authority: "source", revokeAt: "never" },
  ] as const)(
    "$mode checks $authority authority after $revokeAt",
    async ({ mode, authority, revokeAt }) => {
      const remote = path.join(root, "remote-attachments");
      await mkdir(remote);
      await seedActivePlacement(mode, remote);
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active placement");
      }
      const prior = await placements.claimTurn({
        ...sessionTarget,
        claimId: "prior-result",
        runId: "prior-run",
        owner: placementTurnOwner(active),
      });
      await placements.markWorkspaceResultPending(prior);
      const waiting = vi.spyOn(placements, "waitForTurnClaimRelease");
      const bytes = Buffer.from("authorized attachment original");
      const saved = await saveMediaBuffer(bytes, "text/plain", "inbound", bytes.length, "note.txt");
      const abort = new AbortController();
      const authorityTurn = await revocableTurn(
        "followup",
        authority,
        "test.reconciliation-source",
      );
      const { revoke } = authorityTurn;
      const input = {
        ...authorityTurn.input,
        abortSignal: abort.signal,
        media: [{ path: saved.path, contentType: "text/plain" }],
      };
      // Real attachment commands write to an isolated workspace; only transport is synthetic.
      const executedCommands: string[][] = [];
      const runWorkspaceCommand = vi.fn<WorkerTunnelHandle["runWorkspaceCommand"]>(
        async (command) => {
          // Simulate transport readiness yielding before its synchronous dispatch guard.
          await Promise.resolve();
          if (revokeAt === "dispatch") {
            revoke();
          }
          command.assertCurrent?.();
          executedCommands.push([...command.argv]);
          const result = await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 5000,
          });
          if (revokeAt === command.argv[5]) {
            revoke();
          }
          return result;
        },
      );
      const environments = remoteExecEnvironment(runWorkspaceCommand, () => {
        if (revokeAt === "tunnel") {
          revoke();
        }
      });
      const resolveWorkspace = vi.fn(async () => {
        if (revokeAt === "workspace") {
          revoke();
        }
        return { kind: "local" as const, path: root };
      });
      const runLocal = vi.fn(async () => {
        const directories = (await readdir(remote)).filter((name) =>
          name.startsWith(WORKER_ATTACHMENT_DIRECTORY_PREFIX),
        );
        expect(directories).toHaveLength(1);
        const directory = path.join(remote, directories[0]!);
        const files = await readdir(directory);
        expect(files).toHaveLength(1);
        expect(await readFile(path.join(directory, files[0]!))).toEqual(bytes);
        return { meta: { durationMs: 1 } };
      });
      const uninstall = installSessionPlacementAdmissionProvider(
        createWorkerSessionTurnPlacementProvider({ environments, placements, resolveWorkspace }),
      );
      const run = withSessionPlacementTurnAdmission(
        { ...sessionTarget, runId: input.runId },
        input,
        runLocal,
      );
      void run.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
        expect(runWorkspaceCommand).not.toHaveBeenCalled();
        if (revokeAt === "wait") {
          revoke();
        }
        await placements.updateWorkspaceBaseManifest({ claim: prior, manifestRef: MANIFEST_REF });
        await placements.acceptWorkspaceResult(prior);
        await placements.completeWorkspaceResultAndReleaseTurn(prior);
        if (revokeAt === "never") {
          await expect(run).resolves.toMatchObject({ meta: { durationMs: 1 } });
          expect(runLocal).toHaveBeenCalledOnce();
          expect(runWorkspaceCommand).toHaveBeenCalled();
        } else {
          await expect(run).rejects.toThrow(/authority/);
          expect(abort.signal.aborted).toBe(false);
          const transferred = revokeAt === "init" || revokeAt === "write";
          expect(environments.startTunnel).toHaveBeenCalledTimes(
            transferred || revokeAt === "tunnel" || revokeAt === "dispatch" ? 1 : 0,
          );
          if (transferred) {
            expect(executedCommands.map((argv) => argv[5])).toEqual(
              revokeAt === "init" ? ["init", "cleanup"] : ["init", "write", "cleanup"],
            );
          } else {
            expect(runWorkspaceCommand).toHaveBeenCalledTimes(revokeAt === "dispatch" ? 1 : 0);
            expect(executedCommands).toEqual([]);
          }
          expect(runLocal).not.toHaveBeenCalled();
          expect(await readdir(remote)).toEqual([]);
        }
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      } finally {
        abort.abort();
        await run.catch(() => undefined);
        authorityTurn.close();
        uninstall();
      }
    },
  );
});
