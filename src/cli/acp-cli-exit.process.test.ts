import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, it, onTestFinished } from "vitest";
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

async function createAcpProcessEnv(): Promise<NodeJS.ProcessEnv> {
  const state = await createOpenClawTestState({
    applyEnv: false,
    label: "acp-process",
    scenario: "minimal",
  });
  onTestFinished(() => state.cleanup());
  // Exclude the one-time migration diagnostic from the clean-exit signal.
  closeOpenClawStateDatabaseByPath(openOpenClawStateDatabase({ env: state.env }).path);
  return {
    ...state.env,
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
  // signal; see the settlement diagnostics in sqlite-transaction.ts.
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

it("exits when the client disconnects after sending an initialize frame", async () => {
  const result = await runCliProcessChild({
    nodeArgs: [path.resolve("openclaw.mjs"), "acp", "--require-existing"],
    env: await createAcpProcessEnv(),
    input: `${JSON.stringify(INITIALIZE_FRAME)}\n`,
  });
  expect(result).toMatchObject({ code: 0, signal: null });
  expect(withoutSqliteTransactionWarnings(result.stderr)).toBe("");
});

it("processes an initialize frame buffered before Gateway hello", async () => {
  const env = await createAcpProcessEnv();
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });

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
    await once(wss, "listening");
    const address = wss.address();
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
      env,
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
  }
});
