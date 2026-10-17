// Canvas QA proof crosses the registered agent tool and a real Gateway/node socket.
import path from "node:path";
import { expect, it } from "vitest";
import canvasPlugin from "../../../../extensions/canvas/index.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import { withNodeGateway } from "./node-gateway-fixture.js";

const E2E_TIMEOUT_MS = 180_000;
const SESSION_KEY = "agent:main:canvas-node-qa";
const CANVAS_NODE_COMMANDS = ["canvas.present", "canvas.hide", "canvas.navigate"] as const;

type NodeInvokeFrame = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON: string | null;
  timeoutMs: number;
  idempotencyKey: string;
};

type CapturedInvocation = Omit<NodeInvokeFrame, "id" | "paramsJSON"> & { params: unknown };

const actions = [
  {
    args: {
      action: "present",
      target: "https://canvas.test/present",
      x: 12,
      y: 34,
      width: 640,
      height: 480,
      timeoutMs: 5_001,
    },
    command: "canvas.present",
    params: {
      url: "https://canvas.test/present",
      placement: { x: 12, y: 34, width: 640, height: 480 },
    },
    details: { url: "https://canvas.test/present" },
  },
  {
    args: { action: "hide", timeoutMs: 5_002 },
    command: "canvas.hide",
    params: null,
    details: {},
  },
  {
    args: {
      action: "navigate",
      url: "https://canvas.test/navigate",
      timeoutMs: 5_003,
    },
    command: "canvas.navigate",
    params: { url: "https://canvas.test/navigate" },
    details: { url: "https://canvas.test/navigate" },
  },
] as const;

it(
  "forwards every presenter action and reports the visible outcome",
  { timeout: E2E_TIMEOUT_MS },
  async () => {
    const invocations: CapturedInvocation[] = [];
    const handlerErrors: Error[] = [];
    await withNodeGateway(
      {
        label: "qa-canvas-agent-node",
        plugin: canvasPlugin,
        contracts: { tools: ["canvas"] },
        platform: "macos",
        caps: ["canvas"],
        commands: [...CANVAS_NODE_COMMANDS],
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        },
        config: () => ({
          agents: {
            defaults: { heartbeat: { every: "0m" }, skipBootstrap: true },
            entries: { main: { tools: { allow: ["canvas"] } } },
          },
          plugins: { allow: ["canvas"], entries: { canvas: { enabled: true } } },
        }),
        onInvoke: (client, frame, expectedNodeId) => {
          void respondToCanvasInvocation({ client, frame, expectedNodeId, invocations }).catch(
            (error: unknown) =>
              handlerErrors.push(error instanceof Error ? error : new Error(String(error))),
          );
        },
      },
      async ({ state, config, registry, nodeId, gatewayUrl, gatewayToken }) => {
        expect(registry.registry.tools.map((entry) => entry.pluginId)).toEqual(["canvas"]);
        expect(registry.registry.nodeInvokePolicies).toEqual([
          expect.objectContaining({
            pluginId: "canvas",
            policy: expect.objectContaining({
              commands: [...CANVAS_NODE_COMMANDS],
              defaultPlatforms: ["macos"],
            }),
          }),
        ]);

        const toolRegistration = registry.registry.tools.find(
          (entry) => entry.pluginId === "canvas",
        );
        const registeredTools = toolRegistration?.factory({
          config,
          runtimeConfig: config,
          getRuntimeConfig: () => config,
          workspaceDir: state.workspaceDir,
          sessionKey: SESSION_KEY,
        });
        const canvasTool = Array.isArray(registeredTools)
          ? registeredTools.find((tool) => tool.name === "canvas")
          : registeredTools;
        if (!canvasTool?.execute) {
          throw new Error("expected registered Canvas agent tool");
        }

        for (const action of actions) {
          const result = await canvasTool.execute(`canvas-${action.command}`, {
            ...action.args,
            node: nodeId,
            gatewayUrl,
            gatewayToken,
          });
          expect(result.details).toEqual({ ok: true, node: nodeId, ...action.details });
        }

        expect(handlerErrors).toEqual([]);
        expect(invocations).toHaveLength(actions.length);
        for (const [index, invocation] of invocations.entries()) {
          expect(invocation).toEqual({
            nodeId,
            command: actions[index]?.command,
            params: actions[index]?.params,
            timeoutMs: expect.any(Number),
            idempotencyKey: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
            ),
          });
          expect(invocation.timeoutMs).toBeGreaterThan(0);
          expect(invocation.timeoutMs).toBeLessThanOrEqual(actions[index]?.args.timeoutMs ?? 0);
        }
        expect(new Set(invocations.map((invocation) => invocation.idempotencyKey)).size).toBe(
          actions.length,
        );
      },
    );
  },
);

async function respondToCanvasInvocation(params: {
  client: GatewayClient | undefined;
  expectedNodeId: string;
  frame: unknown;
  invocations: CapturedInvocation[];
}): Promise<void> {
  const frame = params.frame as Partial<NodeInvokeFrame>;
  const client = params.client;
  if (
    !client ||
    typeof frame.id !== "string" ||
    frame.nodeId !== params.expectedNodeId ||
    typeof frame.command !== "string" ||
    typeof frame.timeoutMs !== "number" ||
    typeof frame.idempotencyKey !== "string" ||
    !(frame.paramsJSON === null || typeof frame.paramsJSON === "string")
  ) {
    throw new Error(`invalid Canvas node invocation: ${JSON.stringify(frame)}`);
  }
  const invocation: CapturedInvocation = {
    nodeId: frame.nodeId,
    command: frame.command,
    params: frame.paramsJSON === null ? null : JSON.parse(frame.paramsJSON),
    timeoutMs: frame.timeoutMs,
    idempotencyKey: frame.idempotencyKey,
  };
  params.invocations.push(invocation);

  const responseByCommand: Record<string, unknown> = {
    "canvas.present": { presented: true },
    "canvas.hide": { hidden: true },
    "canvas.navigate": { navigated: true },
  };
  if (!Object.hasOwn(responseByCommand, frame.command)) {
    throw new Error(`unexpected Canvas node command: ${frame.command}`);
  }
  await client.request("node.invoke.result", {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: true,
    payloadJSON: JSON.stringify(responseByCommand[frame.command]),
  });
}
