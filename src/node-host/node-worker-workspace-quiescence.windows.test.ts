import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  NODE_WORKSPACE_QUIESCENCE_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceQuiescenceInput,
} from "../worker/node-workspace-protocol.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Native Windows only: this exercises the real Job-backed command runner and
// Windows filesystem/environment, not a stubbed platform or script-only entry.
describe.runIf(process.platform === "win32")("Windows node-host quiescence", () => {
  it("keeps the caller-bound SQLite lease through command cleanup, fences another nonce, and releases it", async () => {
    const root = fs.realpathSync(tempDirs.make("node-quiescence-win-"));
    const identity = {
      gatewayNamespace: "gateway-windows",
      environmentId: "environment-windows",
      sessionId: "session-windows",
      generation: 1,
    };
    const hash = (value: string, size: number) =>
      createHash("sha256").update(value).digest("hex").slice(0, size);
    const home = path.join(
      root,
      identity.gatewayNamespace,
      "workspaces",
      hash(identity.environmentId, 16),
      hash(identity.sessionId, 32),
    );
    const workspaceDir = path.join(home, "1");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const runtime = new NodeWorkerWorkspaceRuntime({
      root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: root,
        USERPROFILE: root,
        TEMP: root,
        TMP: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
    });
    const command = (operation: NodeWorkerWorkspaceQuiescenceInput) =>
      runtime.exec(
        parseNodeWorkerWorkspaceExecInput(
          JSON.stringify({
            ...identity,
            argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, workspaceDir],
            quiescence: operation,
          }),
        ),
      );
    const readLease = () => {
      const database = new DatabaseSync(
        path.join(home, ".openclaw-worker", "quiescence", "windows-shared-host.sqlite"),
        { readOnly: true },
      );
      try {
        const row = database
          .prepare("SELECT lease_json FROM workspace_leases WHERE workspace_key = ?")
          .get(hash(workspaceDir, 64));
        return row ? JSON.parse(String(row.lease_json)) : undefined;
      } finally {
        database.close();
      }
    };
    const nonce = "a".repeat(32);
    try {
      await expect(command({ action: "acquire", nonce, timeoutMs: 30_000 })).resolves.toMatchObject(
        {
          code: 0,
          stdout: "quiesced " + nonce + "\n",
          workspaceDir,
        },
      );
      expect(readLease()).toMatchObject({ nonce, sharedHost: true, processes: [], watchdog: null });
      const before = readLease();
      const foreground = await runtime.exec({
        ...identity,
        argv: [
          path.basename(process.execPath),
          "-e",
          "process.stdout.write(process.env.USERPROFILE)",
        ],
      });
      expect(foreground).toMatchObject({ code: 0, stdout: home });
      expect(readLease()).toEqual(before);
      await expect(
        command({ action: "acquire", nonce: "b".repeat(32), timeoutMs: 30_000 }),
      ).rejects.toThrow("lease is already active");
      await expect(
        command({
          action: "renew",
          nonce: "b".repeat(32),
          timeoutMs: 30_000,
          validationMode: "final",
        }),
      ).rejects.toThrow();
      expect(readLease()).toEqual(before);
      // App retirement must not retire infrastructure lease control.
      await runtime.processes.stopEnvironment({ ...identity, ownerEpoch: 1 });
      await expect(
        command({ action: "renew", nonce, timeoutMs: 30_000, validationMode: "final" }),
      ).resolves.toMatchObject({ code: 0, stdout: "renewed " + nonce + "\n" });
      expect(readLease()).toMatchObject({ nonce, processes: [], watchdog: null });
      await expect(command({ action: "release", nonce })).resolves.toMatchObject({ code: 0 });
      expect(readLease()).toBeUndefined();
    } finally {
      await runtime.quiescence.close();
      await runtime.processes.close();
    }
  });
});
