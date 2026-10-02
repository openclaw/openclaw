import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as clientStore from "../agents/harness/native-hook-relay-client-store.js";
import { writeNativeHookRelayBridgeRecord } from "../agents/harness/native-hook-relay-store.js";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { runNativeHookRelayCliFromArgv } from "./native-hook-relay-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("native hook relay locator admission", () => {
  it.for(["available", "transient lock", "locked through deadline"] as const)(
    "settles a registered loopback locator: %s",
    async (mode, context) => {
      const locked = mode === "locked through deadline";
      if (locked && process.versions.bun) {
        context.skip(
          "Node's one-shot locator uses no-wait lock admission; Bun keeps worker isolation",
        );
      }
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
        const blocker = locked ? new DatabaseSync(stateDbPath) : undefined;
        blocker?.exec("PRAGMA journal_mode=DELETE;");
        const before = createHash("sha256")
          .update(await fs.readFile(stateDbPath))
          .digest("hex");
        blocker?.exec("BEGIN EXCLUSIVE;");

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
        const attempted = createDeferredCore();
        const readRecord = clientStore.readNativeHookRelayClientBridgeRecord;
        const read = vi.spyOn(clientStore, "readNativeHookRelayClientBridgeRecord");
        if (mode === "transient lock") {
          read.mockImplementationOnce(async () => {
            attempted.resolve();
            throw Object.assign(new Error("database is locked"), {
              code: "ERR_SQLITE_ERROR",
              errcode: 5,
            });
          });
        }
        if (locked) {
          read.mockImplementation(async (params) => {
            try {
              return await readRecord(params);
            } finally {
              attempted.resolve();
            }
          });
        }
        if (mode !== "available") {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
        }
        const hostSql = process.versions.bun
          ? [
              vi.spyOn(DatabaseSync.prototype, "prepare"),
              vi.spyOn(DatabaseSync.prototype, "exec"),
              vi.spyOn(StatementSync.prototype, "get"),
              vi.spyOn(StatementSync.prototype, "all"),
              vi.spyOn(StatementSync.prototype, "run"),
              vi.spyOn(StatementSync.prototype, "iterate"),
            ]
          : [];
        try {
          const pending = runNativeHookRelayCliFromArgv(
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
              locked ? "pre_tool_use" : "post_tool_use",
              ...(locked ? ["--timeout", "25"] : []),
            ],
            {
              stdin: Readable.from([JSON.stringify(rawPayload)]),
              stdout,
              stderr,
              callGateway: gateway,
            },
          );
          if (mode !== "available") {
            await Promise.race([attempted.promise, pending]);
            await vi.advanceTimersByTimeAsync(25);
          }
          const exitCode = await pending;
          expect(exitCode).toBe(0);
          if (locked) {
            expect(JSON.parse(output)).toMatchObject({
              hookSpecificOutput: {
                permissionDecision: "deny",
                permissionDecisionReason: "Native hook relay timed out",
              },
            });
            expect(errorOutput).toContain("native hook relay timed out");
            expect(received).toBeUndefined();
          } else {
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
          }
          expect(gateway).not.toHaveBeenCalled();
          for (const spy of hostSql) {
            expect(spy).not.toHaveBeenCalled();
          }
          expect(
            createHash("sha256")
              .update(await fs.readFile(stateDbPath))
              .digest("hex"),
          ).toBe(before);
        } finally {
          vi.useRealTimers();
          read.mockRestore();
          for (const spy of hostSql) {
            spy.mockRestore();
          }
          blocker?.exec("ROLLBACK;");
          blocker?.close();
        }
      } finally {
        await closeOpenClawStateDatabaseAsync();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("refuses a newer locator schema without migrating it", async () => {
    const stateDbPath = path.join(tempDirs.make("native-hook-newer-locator-"), "state.sqlite");
    const database = new DatabaseSync(stateDbPath);
    database.exec("PRAGMA user_version=2147483647;");
    database.close();
    const before = await fs.readFile(stateDbPath);
    await expect(
      clientStore.readNativeHookRelayClientBridgeRecord({
        stateDbPath,
        relayId: "newer-schema-fixture",
      }),
    ).rejects.toBeInstanceOf(SqliteSchemaVersionError);
    expect(await fs.readFile(stateDbPath)).toEqual(before);
  });
});
