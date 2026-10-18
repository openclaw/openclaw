// Process regression coverage for ACP bridge disconnect and startup-handshake exit paths.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const INITIALIZE_FRAME = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  },
};

async function createPreparedAcpProcessState() {
  const state = await createOpenClawTestState({
    applyEnv: false,
    label: "acp-process",
    scenario: "minimal",
  });
  try {
    // These cases assert bridge stderr after normal startup. Prepare canonical
    // shared state so the one-time migration diagnostic is not part of that signal.
    const database = openOpenClawStateDatabase({ env: state.env });
    closeOpenClawStateDatabaseByPath(database.path);
    return state;
  } catch (error) {
    await state.cleanup();
    throw error;
  }
}

function createAcpProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    NODE_ENV: undefined,
    NODE_OPTIONS: "--use-openssl-ca",
    NODE_USE_SYSTEM_CA: "0",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_NO_RESPAWN: "1",
    VITEST: undefined,
  };
}

function withoutSqliteTransactionWarnings(stderr: string): string {
  // Slow-hold logger output is load-dependent performance diagnostics, not ACP clean-exit
  // signal; see logSlowTransactionHold in sqlite-transaction.ts.
  return stderr
    .split("\n")
    .filter(
      (line) => !stripVTControlCharacters(line).trimStart().startsWith("[sqlite/transaction]"),
    )
    .join("\n");
}

function waitForJsonLine(child: ChildProcessWithoutNullStreams, id: number) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "";
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new Error(`ACP process exited before response (code=${code}, signal=${signal})`));
    };
    const finish = (response: Record<string, unknown>) => {
      child.off("exit", onExit);
      resolve(response);
    };

    child.once("exit", onExit);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response.id === id) {
          finish(response);
          return;
        }
      }
    });
  });
}

describe("ACP CLI process exit", () => {
  it("exits when the client disconnects after sending an initialize frame", async () => {
    const state = await createPreparedAcpProcessState();
    try {
      const result = await runCliProcessChild({
        nodeArgs: [path.resolve("openclaw.mjs"), "acp", "--require-existing"],
        env: createAcpProcessEnv(state.env),
        input: `${JSON.stringify(INITIALIZE_FRAME)}\n`,
      });

      expect(result).toMatchObject({ code: 0, signal: null });
      expect(withoutSqliteTransactionWarnings(result.stderr)).toBe("");
    } finally {
      await state.cleanup();
    }
  });

  it("processes an initialize frame buffered before Gateway hello", async () => {
    const state = await createPreparedAcpProcessState();
    const server = createServer();
    const wss = new WebSocketServer({ server });

    try {
      wss.on("connection", (socket) => {
        sendMinimalGatewayConnectChallenge(socket, "acp-process-test");
        socket.on("message", (data) => {
          const frame = JSON.parse(rawDataToString(data)) as { id: string; method: string };
          if (frame.method !== "connect") {
            return;
          }
          sendMinimalGatewayResponse(
            socket,
            frame.id,
            buildMinimalGatewayHelloOkPayload({
              connId: "acp-process-test",
              auth: { role: "operator", scopes: ["operator.admin"] },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("ACP process test Gateway did not get a TCP address");
      }

      let response: Record<string, unknown> | undefined;
      const result = await runCliProcessChild({
        nodeArgs: [
          path.resolve("openclaw.mjs"),
          "acp",
          "--require-existing",
          "--url",
          `ws://127.0.0.1:${address.port}`,
        ],
        env: createAcpProcessEnv(state.env),
        interact: async (runningChild) => {
          const responsePromise = waitForJsonLine(runningChild, INITIALIZE_FRAME.id);
          // Write before the Gateway handshake completes. Startup monitoring must
          // retain this frame for the eventual AgentSideConnection reader.
          runningChild.stdin.write(`${JSON.stringify(INITIALIZE_FRAME)}\n`);
          response = await responsePromise;
          runningChild.stdin.end();
        },
      });

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: INITIALIZE_FRAME.id,
        result: { protocolVersion: INITIALIZE_FRAME.params.protocolVersion },
      });
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(withoutSqliteTransactionWarnings(result.stderr)).toBe("");
    } finally {
      await closeMinimalGatewayServer(wss);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await state.cleanup();
    }
  });
});
