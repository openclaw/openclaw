import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  saveExecApprovals,
  testing as approvalsTesting,
} from "../infra/exec-approvals-store.test-support.js";
import type { ExecHostRequest } from "../infra/exec-host.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";

describe.runIf(process.platform !== "win32")("enforced exec host transport boundary", () => {
  it("does not replay locally when a completed execution loses its socket response", async () => {
    await withTestDir({ prefix: "oc-run-", parentDir: "/tmp" }, async (dir) => {
      await withEnvAsync(
        { OPENCLAW_HOME: dir, OPENCLAW_STATE_DIR: path.join(dir, "state") },
        async () => {
          await closeOpenClawStateDatabaseAsync();
          approvalsTesting.reset();
          const socketPath = path.join(dir, "host.sock");
          const token = "enforced-exec-host-test-token";
          const marker = path.join(dir, "executions");
          const command = [
            "/bin/sh",
            "-c",
            'printf "START\\nCOMPLETE\\n" >> "$1"',
            "exec-proof",
            marker,
          ];
          const order: string[] = [];
          const sockets: net.Socket[] = [];
          const closes: Promise<void>[] = [];
          const failures: unknown[] = [];
          let handler = Promise.resolve();
          const server = net.createServer({ allowHalfOpen: true }, (socket) => {
            sockets.push(socket);
            closes.push(
              new Promise<void>((resolve) => {
                socket.once("close", resolve);
              }),
            );
            socket.on("error", (error) => failures.push(error));
            let wire = "";
            socket.setEncoding("utf8");
            socket.on("data", (chunk: string) => {
              wire += chunk;
            });
            handler = (async () => {
              await once(socket, "end");
              const envelope = JSON.parse(wire) as {
                nonce: string;
                ts: number;
                hmac: string;
                requestJson: string;
              };
              expect(envelope.hmac).toBe(
                crypto
                  .createHmac("sha256", token)
                  .update(`${envelope.nonce}:${envelope.ts}:${envelope.requestJson}`)
                  .digest("hex"),
              );
              const request = JSON.parse(envelope.requestJson) as ExecHostRequest;
              expect(request.command).toEqual(command);
              const [executable, ...args] = request.command;
              assert.ok(executable, "Exec peer received an empty command");
              const child = spawn(executable, args, {
                cwd: dir,
                env: { HOME: dir, PATH: "/usr/bin:/bin" },
                stdio: "ignore",
              });
              expect(await once(child, "close")).toEqual([0, null]);
              expect(await fs.readFile(marker, "utf8")).toBe("START\nCOMPLETE\n");
              order.push("child-completed");
              socket.end();
              order.push("response-dropped");
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
            await handleSystemRunInvoke({
              params: { command, cwd: dir, sessionKey: "agent:main:proof" },
              skillBins: { current: async () => [] },
              preferMacAppExecHost: true,
              getRuntimeConfig: () => ({}),
              runCommand,
              sendInvokeResult,
              sendNodeEvent,
            });
            await handler;
            expect(failures).toEqual([]);
            expect(order).toEqual(["child-completed", "response-dropped"]);
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
            await Promise.all(closes);
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
            approvalsTesting.reset();
            await closeOpenClawStateDatabaseAsync();
          }
        },
      );
    });
  });
});
