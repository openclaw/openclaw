import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("usage.cost multi-agent e2e (#20558)", () => {
  it("should include tokens from all agents, not just main", async () => {
    const ts = new Date().toISOString();
    const stateDir = process.env.OPENCLAW_STATE_DIR!;

    // Write multi-agent config
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      session: { mainKey: "main-test" },
      agents: {
        list: [
          { id: "main", name: "Main Agent" },
          { id: "worker", name: "Worker Agent" },
        ],
      },
    });

    // Create session data for "main" agent (150 tokens, $0.10)
    const mainDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(mainDir, { recursive: true });
    await fs.writeFile(
      path.join(mainDir, "sess-main-e2e.jsonl"),
      JSON.stringify({
        type: "message",
        timestamp: ts,
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.1 } },
        },
      }),
      "utf-8",
    );

    // Create session data for "worker" agent (300 tokens, $0.20)
    const workerDir = path.join(stateDir, "agents", "worker", "sessions");
    await fs.mkdir(workerDir, { recursive: true });
    await fs.writeFile(
      path.join(workerDir, "sess-worker-e2e.jsonl"),
      JSON.stringify({
        type: "message",
        timestamp: ts,
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: { input: 200, output: 100, totalTokens: 300, cost: { total: 0.2 } },
        },
      }),
      "utf-8",
    );

    // Start real gateway, connect, call usage.cost RPC
    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });

      const res = await rpcReq<{
        totals: { totalTokens: number; totalCost: number };
        daily: Array<{ date: string; totalTokens: number }>;
      }>(ws, "usage.cost", { days: 7 });

      expect(res.ok).toBe(true);

      const totals = res.payload!.totals;
      console.log(`Total tokens from usage.cost RPC: ${totals.totalTokens}`);
      console.log(`Total cost from usage.cost RPC: ${totals.totalCost}`);

      if (totals.totalTokens < 450) {
        console.log("❌ BUG CONFIRMED: usage.cost only scans main agent");
        console.log(`   Expected >= 450 (main 150 + worker 300), got ${totals.totalTokens}`);
      }

      // Should be 450 (main 150 + worker 300)
      expect(totals.totalTokens).toBeGreaterThanOrEqual(450);
      expect(totals.totalCost).toBeGreaterThanOrEqual(0.3 - 0.001);
    });
  });
});
