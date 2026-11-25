import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { startGateway } from "./gateway-backed-exit.test-helpers.js";

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

async function waitForJsonLine(child: ChildProcessWithoutNullStreams, id: number) {
  const lines = createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const response = JSON.parse(line) as Record<string, unknown>;
      if (response.id === id) {
        return response;
      }
    }
    throw new Error("ACP stdout ended before the initialize response");
  } finally {
    lines.close();
  }
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
  const gateway = await startGateway({}, () => ({
    auth: { role: "operator", scopes: ["operator.admin"] },
  }));

  try {
    let response: Record<string, unknown> | undefined;
    const result = await runCliProcessChild({
      nodeArgs: [path.resolve("openclaw.mjs"), "acp", "--require-existing", "--url", gateway.url],
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
    await gateway.close();
  }
});
