import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import { expect, it, onTestFinished, vi } from "vitest";
import * as runtimeConfig from "../config/config.js";
import {
  saveExecApprovals,
  testing as approvalsTesting,
} from "../infra/exec-approvals-store.test-support.js";
import type { ExecHostRequest } from "../infra/exec-host.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";

it.runIf(process.platform !== "win32")(
  "does not replay locally when a completed execution loses its socket response",
  async () => {
    await withTestDir({ prefix: "oc-run-", parentDir: "/tmp" }, async (dir) => {
      await withEnvAsync(
        { OPENCLAW_HOME: dir, OPENCLAW_STATE_DIR: path.join(dir, "state") },
        async () => {
          await closeOpenClawStateDatabaseAsync();
          approvalsTesting.reset();
          const socketPath = path.join(dir, "host.sock");
          const token = "enforced-exec-host-test-token";
          const marker = path.join(dir, "executions");
          const command = ["/bin/sh", "-c", 'printf "START\\nCOMPLETE\\n" >> "$1"', "_", marker];
          const sockets: net.Socket[] = [];
          const failures: unknown[] = [];
          let handler = Promise.resolve();
          const server = net.createServer({ allowHalfOpen: true }, (socket) => {
            sockets.push(socket);
            socket.on("error", (error) => failures.push(error));
            handler = (async () => {
              // Signed-envelope validation belongs to exec-host.socket.test.ts.
              const envelope = JSON.parse(await text(socket)) as { requestJson: string };
              const request = JSON.parse(envelope.requestJson) as ExecHostRequest;
              expect(request.command).toEqual(command);
              const child = spawn("/bin/sh", request.command.slice(1), {
                cwd: dir,
                env: { HOME: dir, PATH: "/usr/bin:/bin" },
                stdio: "ignore",
              });
              expect(await once(child, "close")).toEqual([0, null]);
              socket.end();
            })().catch((error: unknown) => {
              failures.push(error);
              socket.destroy();
            });
          });
          try {
            const listening = once(server, "listening");
            server.listen(socketPath);
            await listening;
            saveExecApprovals({
              version: 1,
              socket: { path: socketPath, token },
              defaults: { security: "full", ask: "off", autoAllowSkills: false },
              agents: {},
            });
            const runCommand = vi.fn<Parameters<typeof handleSystemRunInvoke>[0]["runCommand"]>();
            const sendInvokeResult = vi.fn();
            const sendNodeEvent = vi.fn();
            const config = vi.spyOn(runtimeConfig, "getRuntimeConfig").mockReturnValue({});
            onTestFinished(() => config.mockRestore());
            await handleSystemRunInvoke({
              params: { command, cwd: dir, sessionKey: "agent:main:proof" },
              skillBins: { current: async () => [] },
              preferMacAppExecHost: true,
              runCommand,
              sendInvokeResult,
              sendNodeEvent,
            });
            await handler;
            expect(failures).toEqual([]);
            expect(runCommand).not.toHaveBeenCalled();
            expect(sendInvokeResult).toHaveBeenCalledExactlyOnceWith({
              ok: false,
              error: {
                code: "UNKNOWN",
                message:
                  "UNKNOWN: macOS app exec host response was lost; execution outcome is unknown",
              },
            });
            expect(sendNodeEvent).toHaveBeenCalledExactlyOnceWith(
              "exec.denied",
              expect.objectContaining({ host: "node", reason: "response-lost" }),
            );
            expect(await fs.readFile(marker, "utf8")).toBe("START\nCOMPLETE\n");
          } finally {
            for (const socket of sockets) {
              socket.destroy();
            }
            await handler;
            await server[Symbol.asyncDispose]();
            approvalsTesting.reset();
            await closeOpenClawStateDatabaseAsync();
          }
        },
      );
    });
  },
);
