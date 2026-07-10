/**
 * Real gateway RPC proof for PR #103409: inline avatar cap reduction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createGatewaySuiteHarness, rpcReq } from "./test-helpers.js";
import { testConfigRoot } from "./test-helpers.runtime-state.js";
import { connectOk, installGatewayTestHooks } from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-rpc-proof-"));
const workspaces = [1, 2, 3].map((i) => {
  const dir = path.join(root, `agent-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});
fs.writeFileSync(path.join(workspaces[0], "small.png"), Buffer.alloc(32 * 1024));
fs.writeFileSync(path.join(workspaces[1], "medium.png"), Buffer.alloc(200 * 1024));
fs.writeFileSync(path.join(workspaces[2], "large.png"), Buffer.alloc(500 * 1024));

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>;

beforeAll(async () => {
  const configPath = path.join(testConfigRoot.value, "openclaw.json");
  const config = {
    agents: {
      list: [
        {
          id: "agent-1",
          name: "small",
          workspace: workspaces[0],
          identity: { avatar: "small.png" },
        },
        {
          id: "agent-2",
          name: "medium",
          workspace: workspaces[1],
          identity: { avatar: "medium.png" },
        },
        {
          id: "agent-3",
          name: "large",
          workspace: workspaces[2],
          identity: { avatar: "large.png" },
        },
      ],
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  harness = await createGatewaySuiteHarness();
  ws = await harness.openWs();
  await connectOk(ws, { scopes: ["operator.read"] });
}, 60_000);

afterAll(async () => {
  ws?.close();
  await harness?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("proof: real gateway RPC agentsList shows inline cap behavior", async () => {
  const response = await rpcReq<Record<string, unknown>>(ws, "chat.startup", {
    sessionKey: "main",
  });
  const agentsList = response.payload?.agentsList as
    | { agents?: Array<Record<string, unknown>> }
    | undefined;
  const agents = agentsList?.agents ?? [];
  console.log("[rpc-proof] agents count:", agents.length);
  for (const a of agents) {
    const url = (a.identity as Record<string, unknown> | undefined)?.avatarUrl as
      | string
      | undefined;
    console.log(
      `  agent=${String(a.id)} avatarUrl=${url ? String(url.length) + " chars" : "undefined (capped)"}`,
    );
  }
  expect(response.ok).toBe(true);
  const a3 = agents.find((a) => a.id === "agent-3") as Record<string, unknown> | undefined;
  expect((a3?.identity as Record<string, unknown> | undefined)?.avatarUrl).toBeUndefined();
});
