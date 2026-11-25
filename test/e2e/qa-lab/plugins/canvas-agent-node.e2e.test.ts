// Canvas QA proof crosses the registered agent tool and a real Gateway/node socket.
import path from "node:path";
import { expect, it } from "vitest";
import canvasPlugin from "../../../../extensions/canvas/index.js";
import { withNodeGateway } from "./node-gateway-fixture.js";

const E2E_TIMEOUT_MS = 180_000;
const SESSION_KEY = "agent:main:canvas-node-qa";
const CANVAS_NODE_COMMANDS = ["canvas.present", "canvas.hide", "canvas.navigate"] as const;

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
            defaults: { skipBootstrap: true },
            entries: { main: { tools: { allow: ["canvas"] } } },
          },
          plugins: { allow: ["canvas"], entries: { canvas: { enabled: true } } },
        }),
        onInvoke: ({ command }) => {
          const responseByCommand: Record<string, unknown> = {
            "canvas.present": { presented: true },
            "canvas.hide": { hidden: true },
            "canvas.navigate": { navigated: true },
          };
          expect(Object.hasOwn(responseByCommand, command)).toBe(true);
          return JSON.stringify(responseByCommand[command]);
        },
      },
      async ({ state, config, registry, nodeId, gatewayUrl, gatewayToken, invocations }) => {
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
