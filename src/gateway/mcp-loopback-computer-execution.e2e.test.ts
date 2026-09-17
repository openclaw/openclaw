/**
 * Runtime proof for #147420: a paired node's computer execution must be
 * released when the MCP loopback client grant that opened it ends. Drives a
 * real Gateway, a real paired node running the shared computer-use provider
 * contract (the code that raises COMPUTER_HOST_BUSY), and the real MCP loopback
 * server, then asserts the next run's screenshot is served instead of refused.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";
import { registerComputerUseProvider } from "../plugins/computer-use-registration.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
  type McpLoopbackClientGrantCloseReason,
} from "./mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

const NODE_DISPLAY_NAME = "Fixture Desktop Node";
const NODE_COMMANDS = ["screen.snapshot", "computer.act"];
const SESSION_KEY = "agent:main:main";
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
// Pairing setup, two loopback tool calls, and the node close round trip.
const PROOF_TIMEOUT_MS = 120_000;

type NodeHostCommand = Parameters<
  Parameters<typeof registerComputerUseProvider>[0]["registerNodeHostCommand"]
>[0];

const descriptor: ComputerUseCapabilityDescriptor = {
  contractVersion: 2,
  provider: { id: "fixture-computer", label: "Fixture computer", generation: "generation-1" },
  actions: ["screenshot"],
  targets: ["screen"],
  deliveryModes: ["foreground"],
  observations: ["image"],
  features: { recording: false, agentCursor: false, multiDisplay: false },
};

/** The node side: the shared provider contract in front of a fake one-pixel screen. */
function createFixtureNode() {
  const opened: string[] = [];
  const closed: Array<{ executionId: string; reason: string }> = [];
  // Node-side order of execution opens and closes, as the provider saw them.
  const events: string[] = [];
  const handlers = new Map<string, NodeHostCommand>();
  registerComputerUseProvider(
    {
      registerNodeHostCommand: (command) => {
        handlers.set(command.command, command);
      },
    },
    {
      id: "fixture-computer",
      label: "Fixture computer",
      isAvailable: () => true,
      capabilities: () => descriptor,
      openExecution: async ({ executionId }) => {
        opened.push(executionId);
        events.push(`open:${executionId}`);
        return {
          snapshot: async () =>
            JSON.stringify({
              format: "png",
              base64: TINY_PNG_BASE64,
              displayFrameId: `frame-${opened.length}`,
              width: 1,
              height: 1,
              screenIndex: 0,
            }),
          act: async () => JSON.stringify({ ok: true }),
          close: async (reason) => {
            closed.push({ executionId, reason });
            events.push(`close:${executionId}`);
          },
        };
      },
    },
  );
  return { handlers, opened, closed, events };
}

let ws: WebSocket;
let port = 0;
let node: GatewayClient | undefined;
let gatewayUrlEnv: ReturnType<typeof captureEnv> | undefined;
const admissions = new Map<string, PreparedAgentRunAdmission>();

/** Admits an agent run the way the Gateway does before it mints a CLI client grant. */
async function admitRun(runId: string) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-loopback-computer-e2e", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.set(runId, admission);
  return await admission.admit("gateway", `gateway-${runId}`);
}

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

afterAll(async () => {
  for (const admission of admissions.values()) {
    admission.close();
  }
  gatewayUrlEnv?.restore();
  await node?.stopAndWait();
});

describe("mcp loopback computer execution lifecycle", () => {
  it(
    "serves the next run's screenshot after the previous grant's execution is closed",
    async () => {
      const fixture = createFixtureNode();
      const answerInvoke = (event: { event?: string; payload?: unknown }) => {
        if (event.event !== "node.invoke.request") {
          return;
        }
        const payload = event.payload as {
          id?: unknown;
          nodeId?: unknown;
          command?: unknown;
          paramsJSON?: unknown;
        };
        const id = typeof payload.id === "string" ? payload.id : "";
        const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "";
        const command = typeof payload.command === "string" ? payload.command : "";
        if (!id || !nodeId || !command) {
          return;
        }
        void (async () => {
          const client = node;
          if (!client) {
            return;
          }
          try {
            const handler = fixture.handlers.get(command);
            if (!handler) {
              throw new Error(`unsupported node command ${command}`);
            }
            const payloadJSON = await handler.handle(
              typeof payload.paramsJSON === "string" ? payload.paramsJSON : null,
            );
            await client.request("node.invoke.result", { id, nodeId, ok: true, payloadJSON });
          } catch (error) {
            await client.request("node.invoke.result", {
              id,
              nodeId,
              ok: false,
              error: {
                code: "UNAVAILABLE",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        })();
      };

      const connectNode = async () =>
        await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: process.env.OPENCLAW_GATEWAY_TOKEN,
          role: "node",
          clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientVersion: "1.0.0",
          clientDisplayName: NODE_DISPLAY_NAME,
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.NODE,
          scopes: [],
          commands: NODE_COMMANDS,
          computerUse: descriptor,
          onEvent: answerInvoke,
          timeoutMessage: "timeout waiting for node to connect",
        });
      const connectWithDevicePairing = async () => {
        try {
          return await connectNode();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("pairing required")) {
            throw error;
          }
          const pairings = await listDevicePairing();
          for (const pending of pairings.pending) {
            await approveDevicePairing(pending.requestId, {
              callerScopes: pending.scopes ?? ["operator.admin"],
            });
          }
          return await connectNode();
        }
      };
      type ListedNode = {
        nodeId: string;
        displayName?: string;
        connected?: boolean;
        computerUse?: unknown;
      };
      const findNode = async () => {
        const listed = await rpcReq<{ nodes?: ListedNode[] }>(ws, "node.list", {});
        return (listed.payload?.nodes ?? []).find(
          (entry) => entry.connected && entry.displayName === NODE_DISPLAY_NAME,
        );
      };

      const provisional = await connectWithDevicePairing();
      const provisionalNodeId = (await findNode())?.nodeId;
      if (!provisionalNodeId) {
        throw new Error("expected a connected node id before pairing");
      }
      await provisional.stopAndWait();
      const pairing = await requestNodePairing({
        nodeId: provisionalNodeId,
        displayName: NODE_DISPLAY_NAME,
        platform: "linux",
        commands: NODE_COMMANDS,
      });
      await approveNodePairing(pairing.request.requestId, {
        callerScopes: ["operator.admin", "operator.write"],
      });
      node = await connectNode();
      await vi.waitFor(async () => {
        expect((await findNode())?.computerUse).toBeDefined();
      });
      // The Gateway's own tool calls reach the node through this URL.
      gatewayUrlEnv = captureEnv(["OPENCLAW_GATEWAY_URL"]);
      setTestEnvValue("OPENCLAW_GATEWAY_URL", `ws://127.0.0.1:${port}`);

      await ensureMcpLoopbackServer();
      const runtime = getActiveMcpLoopbackRuntime();
      if (!runtime) {
        throw new Error("expected the MCP loopback server to be running");
      }
      // Admit a run and mint + activate its client grant the way a Gateway-launched CLI run
      // does. With `adoptedBy`, the fresh grant is first transferred onto the bearer a warm
      // child already holds, exactly as adoptProcessToken does, and activated there.
      const mintRunGrant = async (runId: string, adoptedBy?: string) => {
        const grant = mintMcpLoopbackClientGrant({
          context: {
            sessionKey: SESSION_KEY,
            runId,
            senderIsOwner: true,
            modelHasVision: true,
            toolsAllow: ["computer"],
          },
          runtimeOwnerToken: runtime.ownerToken,
          admittedRunContext: await admitRun(runId),
        });
        let token = grant.token;
        if (adoptedBy) {
          if (
            !transferMcpLoopbackClientGrant({
              sourceToken: grant.token,
              targetToken: adoptedBy,
              runtimeOwnerToken: runtime.ownerToken,
            })
          ) {
            throw new Error(`expected ${runId} to adopt the process bearer`);
          }
          token = adoptedBy;
        }
        const captureKey = `capture-${runId}`;
        if (
          !activateMcpLoopbackClientGrantCapture({
            token,
            runtimeOwnerToken: runtime.ownerToken,
            captureKey,
          })
        ) {
          throw new Error(`expected an active capture for ${runId}`);
        }
        return { token, captureKey, runId };
      };
      // Run end: the CLI runner revokes the grant with the run's settlement and the admission closes.
      const endRun = (
        grant: { token: string; runId: string },
        outcome: McpLoopbackClientGrantCloseReason,
      ) => {
        const revoked = revokeMcpLoopbackClientGrant(grant.token, outcome);
        admissions.get(grant.runId)?.close();
        return revoked;
      };
      const screenshotThrough = async (
        grant: { token: string; captureKey: string },
        id: number,
      ) => {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${grant.token}`,
            "x-openclaw-cli-capture-key": grant.captureKey,
            "x-session-key": SESSION_KEY,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "computer", arguments: { action: "screenshot" } },
          }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as {
          result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
          error?: unknown;
        };
      };

      // Run 1 opens the node execution through the loopback computer tool.
      const firstGrant = await mintRunGrant("run-1");
      const first = await screenshotThrough(firstGrant, 1);
      expect(first.error).toBeUndefined();
      expect(first.result?.isError).not.toBe(true);
      expect(fixture.opened).toHaveLength(1);

      // Run 1 completed: the grant is revoked exactly as the CLI runner does at run end,
      // and the node must see `completion` so a provider keeps the run's artifacts.
      expect(endRun(firstGrant, "completion")).toBe(true);

      // Run 2 must get its own execution instead of COMPUTER_HOST_BUSY, and the
      // Gateway must have delivered run 1's close to the node before run 2's snapshot.
      const secondGrant = await mintRunGrant("run-2");
      const second = await screenshotThrough(secondGrant, 2);
      const secondText = (second.result?.content ?? []).map((entry) => entry.text ?? "").join("\n");
      expect(secondText).not.toContain("COMPUTER_HOST_BUSY");
      expect(second.error).toBeUndefined();
      expect(second.result?.isError).not.toBe(true);
      expect(fixture.closed).toEqual([{ executionId: fixture.opened[0], reason: "completion" }]);
      expect(fixture.opened).toHaveLength(2);
      expect(fixture.opened[1]).not.toBe(fixture.opened[0]);
      expect(fixture.events).toEqual([
        `open:${fixture.opened[0]}`,
        `close:${fixture.opened[0]}`,
        `open:${fixture.opened[1]}`,
      ]);

      // Run 2 is cancelled: the node sees `cancel`, not a completion it never reached.
      endRun(secondGrant, "cancel");
      await vi.waitFor(() => {
        expect(fixture.closed).toEqual([
          { executionId: fixture.opened[0], reason: "completion" },
          { executionId: fixture.opened[1], reason: "cancel" },
        ]);
      });

      // Run 3 rides a warm child: its grant is adopted by the process bearer, the
      // screenshot is served through that bearer, and terminal cleanup revokes the
      // bearer (not the retired minted token), so the node is released with `completion`.
      const processBearer = `process-bearer-${Date.now()}`;
      const thirdGrant = await mintRunGrant("run-3", processBearer);
      expect(thirdGrant.token).toBe(processBearer);
      const third = await screenshotThrough(thirdGrant, 3);
      expect(third.error).toBeUndefined();
      expect(third.result?.isError).not.toBe(true);
      expect(fixture.opened).toHaveLength(3);
      expect(endRun(thirdGrant, "completion")).toBe(true);
      await vi.waitFor(() => {
        expect(fixture.closed).toEqual([
          { executionId: fixture.opened[0], reason: "completion" },
          { executionId: fixture.opened[1], reason: "cancel" },
          { executionId: fixture.opened[2], reason: "completion" },
        ]);
      });
    },
    PROOF_TIMEOUT_MS,
  );
});
