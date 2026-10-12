import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient, registerNodeSession } from "../node-registry.test-helpers.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import type { GatewayClient } from "./client-types.js";
import { terminalUploadHandlers } from "./terminal-upload.js";
import { openTerminalSession } from "./terminal.js";

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => resetPluginRuntimeStateForTest());

describe.each([
  "codex.terminal.start.v1",
  "anthropic.claude.terminal.start.v1",
  "codex.terminal.resume.v1",
  "anthropic.claude.terminal.resume.v1",
])("final node dispatch authority for %s", (command) => {
  it.each([
    "unchanged",
    "terminal disabled",
    "CLI starts disabled",
    "connection closed",
    "command removed",
    "agent sandboxed",
  ])("revalidates %s after pairing resolution", async (change) => {
    const pairing = createDeferred<{ identity: string; generation: string }>();
    const resolveCurrentPairingState = vi.fn(() => pairing.promise);
    const registry = new NodeRegistry({ resolveCurrentPairingState });
    const frames: string[] = [];
    const node = registry.register(
      {
        connId: "conn-node",
        usesSharedGatewayAuth: false,
        socket: {
          readyState: WebSocket.OPEN,
          send(frame: string) {
            frames.push(frame);
          },
        },
        connect: {
          client: { id: "openclaw-node-host", mode: "node" },
          device: { id: "node-1" },
          commands: [command],
        },
      } as never,
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        terminal: { enabled: true },
        nodes: { commands: { allow: [command] } },
      },
    };
    const policy = createTerminalLaunchPolicy(config);
    const manager = new TerminalSessionManager({ emit: vi.fn() });
    const respond = vi.fn();
    const isConnectionActive = vi.fn(() => true);
    const opts = {
      client: { connId: "conn-1", connect: {} },
      respond,
      context: {
        getRuntimeConfig: () => config,
        resolveTerminalLaunchPolicy: policy.resolve,
        isTerminalEnabled: policy.isEnabled,
        nodeRegistry: registry,
        terminalSessions: manager,
        isConnectionActive,
        logGateway: { info: vi.fn() },
      },
    } as unknown as Parameters<typeof openTerminalSession>[0];
    const requireCliAgents = command.includes(".start.");
    const opening = openTerminalSession(opts, {
      agentId: "main",
      cols: 80,
      rows: 24,
      requireCliAgents,
      resolveCatalogPlan: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        cwd: "/node/worktree",
        paramsJSON: JSON.stringify({ cwd: "/node/worktree" }),
      }),
    });
    try {
      await vi.waitFor(() => expect(resolveCurrentPairingState).toHaveBeenCalledOnce(), {
        interval: 1,
      });
      expect(frames).toEqual([]);
      if (change === "terminal disabled") {
        policy.prepareConfig(
          { ...config, gateway: { ...config.gateway, terminal: { enabled: false } } },
          { restartPending: true },
        );
      } else if (change === "CLI starts disabled") {
        config.gateway!.cliAgents = { enabled: false };
      } else if (change === "connection closed") {
        isConnectionActive.mockReturnValue(false);
      } else if (change === "command removed") {
        node.commands = [];
      } else if (change === "agent sandboxed") {
        policy.prepareConfig(
          { ...config, agents: { entries: { main: { sandbox: { mode: "all" } } } } },
          { restartPending: true },
        );
      }
      pairing.resolve({ identity: "identity-a", generation: "generation-a" });
      await opening;
      if (change === "unchanged" || (change === "CLI starts disabled" && !requireCliAgents)) {
        expect(respond).toHaveBeenCalledWith(true, expect.any(Object));
        expect(JSON.parse(frames[0] ?? "{}")).toMatchObject({
          event: "node.invoke.request",
          payload: { nodeId: "node-1", command },
        });
        expect(manager.size).toBe(1);
      } else {
        expect(frames).toEqual([]);
        expect(manager.size).toBe(0);
        expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      }
    } finally {
      pairing.resolve({ identity: "identity-a", generation: "generation-a" });
      await opening;
      manager.disposeAll();
      registry.unregister("conn-node");
    }
  });
});

it.each([
  { disabled: false, trusted: false },
  { disabled: true, trusted: false },
  { disabled: true, trusted: true },
])(
  "checks remote terminal upload policy at transport handoff ($disabled, $trusted)",
  async ({ disabled, trusted }) => {
    const command = "codex.terminal.resume.v1";
    const uploadCommand = "terminal.upload";
    const entered = createDeferred();
    const pairing = createDeferred<{ identity: string; generation: string }>();
    let holdUpload = false;
    const registry = new NodeRegistry({
      resolveCurrentPairingState: async () => {
        if (holdUpload) {
          entered.resolve();
          return pairing.promise;
        }
        return { identity: "identity-a", generation: "generation-a" };
      },
    });
    const frames: string[] = [];
    registerNodeSession(
      registry,
      makeClient("conn-node", "node-1", frames, {
        commands: [command, uploadCommand],
      }),
      { pairingGeneration: "generation-a" },
    );
    let config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        terminal: { enabled: true },
        uploads: { enabled: true },
        nodes: { commands: { allow: [command, uploadCommand] } },
      },
    };
    const policy = createTerminalLaunchPolicy(config);
    const manager = new TerminalSessionManager({ emit: vi.fn() });
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      getCommittedRuntimeConfig: () => config,
      resolveTerminalLaunchPolicy: policy.resolve,
      isTerminalEnabled: policy.isEnabled,
      nodeRegistry: registry,
      terminalSessions: manager,
      isConnectionActive: () => true,
    });
    const client: GatewayClient = {
      connId: "conn-1",
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        caps: [GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE],
      },
      internal: trusted ? { syntheticClient: true } : undefined,
    };
    const openRespond = vi.fn();
    let uploading: Promise<void> | undefined;
    const uploadFrames = () =>
      frames.flatMap((frame) => {
        const parsed: unknown = JSON.parse(frame);
        return isRecord(parsed) &&
          parsed.event === "node.invoke.request" &&
          isRecord(parsed.payload) &&
          parsed.payload.command === uploadCommand
          ? [parsed.payload]
          : [];
      });
    const dispatched = createDeferred();
    const pushFrames = frames.push.bind(frames);
    const frameWrites = vi.spyOn(frames, "push").mockImplementation((...values) => {
      const count = pushFrames(...values);
      if (uploadFrames().length > 0) {
        dispatched.resolve();
      }
      return count;
    });
    try {
      await openTerminalSession(
        {
          req: { type: "req", id: "open", method: "terminal.open" },
          params: {},
          client,
          context,
          respond: openRespond,
          isWebchatConnect: () => false,
        },
        {
          agentId: "main",
          cols: 80,
          rows: 24,
          resolveCatalogPlan: async () => ({
            kind: "node",
            nodeId: "node-1",
            command,
            cwd: "/node/worktree",
            paramsJSON: "{}",
          }),
        },
      );
      const opened: unknown = openRespond.mock.calls.at(-1)?.[1];
      if (!isRecord(opened) || typeof opened.sessionId !== "string") {
        throw new Error("Expected admitted node terminal");
      }
      holdUpload = true;
      const respond = vi.fn();
      const params = { sessionId: opened.sessionId, name: "proof.txt", contentBase64: "cHJvb2Y=" };
      uploading = Promise.resolve(
        expectDefined(
          terminalUploadHandlers["terminal.upload"],
          "terminal upload handler",
        )({
          req: { type: "req", id: "upload", method: "terminal.upload", params },
          params,
          client,
          context,
          respond,
          isWebchatConnect: () => false,
        }),
      );
      await Promise.race([
        entered.promise,
        uploading.then(() => {
          throw new Error("Upload did not reach pairing preparation");
        }),
      ]);
      config = { ...config, gateway: { ...config.gateway, uploads: { enabled: !disabled } } };
      pairing.resolve({ identity: "identity-a", generation: "generation-a" });
      await Promise.race([dispatched.promise, uploading]);
      const frame = uploadFrames()[0];
      if (frame) {
        if (typeof frame.id !== "string") {
          throw new Error("Expected node upload request id");
        }
        registry.handleInvokeResult({
          id: frame.id,
          nodeId: "node-1",
          connId: "conn-node",
          ok: true,
          payloadJSON: JSON.stringify({ path: "/node/proof.txt", size: 5 }),
        });
      }
      await uploading;
      if (disabled && !trusted) {
        expect.soft(uploadFrames()).toEqual([]);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } }),
        );
      } else {
        expect(uploadFrames()).toHaveLength(1);
        expect(JSON.stringify(frame)).not.toContain("assertCommitAllowed");
        expect(respond).toHaveBeenCalledWith(true, { path: "/node/proof.txt", size: 5 });
      }
    } finally {
      frameWrites.mockRestore();
      pairing.resolve({ identity: "identity-a", generation: "generation-a" });
      manager.disposeAll();
      registry.unregister("conn-node");
      await uploading;
    }
  },
);
