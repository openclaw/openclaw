import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeNativeHookRelayBridgeRecord } from "../agents/harness/native-hook-relay-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { runNativeHookRelayCliFromArgv } from "./native-hook-relay-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("native hook relay locator worker", () => {
  it("invokes a registered loopback locator without host SQLite", async () => {
    const stateDbPath = path.join(tempDirs.make("native-hook-locator-"), "state.sqlite");
    const relayId = "ordinary-locator-fixture";
    const token = "native-hook-token-placeholder";
    const rawPayload = { hook_event_name: "PostToolUse", tool_name: "fixture" };
    const response = { stdout: '{"continue":true}\n', stderr: "", exitCode: 0 };
    let received: unknown;
    let authorized = false;
    const server = createServer((request, reply) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        authorized = request.headers.authorization === `Bearer ${token}`;
        received = JSON.parse(body);
        reply.setHeader("content-type", "application/json");
        reply.end(JSON.stringify({ ok: true, result: response }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a loopback listener");
      }
      await writeNativeHookRelayBridgeRecord({
        stateDbPath,
        record: {
          relayId,
          pid: process.pid,
          hostname: "127.0.0.1",
          port: address.port,
          token,
          expiresAtMs: Date.now() + 60_000,
        },
      });
      await closeOpenClawStateDatabaseAsync();

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let output = "";
      let errorOutput = "";
      stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      stderr.on("data", (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });
      const gateway = vi.fn();
      const sql = {
        prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
        exec: vi.spyOn(DatabaseSync.prototype, "exec"),
        get: vi.spyOn(StatementSync.prototype, "get"),
        all: vi.spyOn(StatementSync.prototype, "all"),
        run: vi.spyOn(StatementSync.prototype, "run"),
        iterate: vi.spyOn(StatementSync.prototype, "iterate"),
      };
      try {
        const exitCode = await runNativeHookRelayCliFromArgv(
          [
            "node",
            "openclaw",
            "hooks",
            "relay",
            "--provider",
            "codex",
            "--relay-id",
            relayId,
            "--state-db",
            stateDbPath,
            "--generation",
            "ordinary-generation",
            "--event",
            "post_tool_use",
          ],
          {
            stdin: Readable.from([JSON.stringify(rawPayload)]),
            stdout,
            stderr,
            callGateway: gateway,
          },
        );
        expect(exitCode).toBe(0);
        expect(output).toBe(response.stdout);
        expect(errorOutput).toBe("");
        expect(authorized).toBe(true);
        expect(received).toEqual({
          provider: "codex",
          relayId,
          generation: "ordinary-generation",
          event: "post_tool_use",
          rawPayload,
        });
        expect(gateway).not.toHaveBeenCalled();
        expect(
          Object.fromEntries(
            Object.entries(sql).map(([name, spy]) => [name, spy.mock.calls.length]),
          ),
        ).toEqual({
          prepare: 0,
          exec: 0,
          get: 0,
          all: 0,
          run: 0,
          iterate: 0,
        });
      } finally {
        for (const spy of Object.values(sql)) {
          spy.mockRestore();
        }
      }
    } finally {
      await closeOpenClawStateDatabaseAsync();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
