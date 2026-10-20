import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../infra/node-commands.js";
import {
  mergeRemoteNodeSkillEntries,
  removeRemoteNodeSkills,
} from "../skills/runtime/remote-skills.js";
import {
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
  TALK_PTT_COMMANDS,
} from "./node-command-policy.js";
import { listConnectedNodePluginTools } from "./node-plugin-tool-snapshot.js";
import {
  NodeRegistry,
  readNodeSessionWithheldCommands,
  type NodeSession,
} from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const registries: NodeRegistry[] = [];
const pairingState = { identity: "policy-identity", generation: "policy-generation" };
const registration = {
  pairingIdentity: pairingState.identity,
  pairingGeneration: pairingState.generation,
};
const nodeTool = {
  pluginId: "qa-policy",
  name: "node_exec",
  description: "Run on the paired node",
  command: "system.run",
};
const nodeSkill = {
  name: "node-work",
  description: "Work on the paired node",
  content: "---\nname: node-work\ndescription: Work on the paired node\n---\nUse this node.\n",
};
const nodeTools = [
  nodeTool,
  {
    ...nodeTool,
    name: "node_screen",
    description: "Unapproved screen command",
    command: "screen.snapshot",
  },
];
function policy(nodes: NonNullable<OpenClawConfig["gateway"]>["nodes"]): OpenClawConfig {
  return { gateway: { nodes } };
}
const denyRun = policy({ commands: { deny: ["system.run"] } });
const denyComputer = policy({ commands: { deny: ["computer.act"] } });

afterEach(() => {
  for (const registry of registries.splice(0)) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
      removeRemoteNodeSkills(session.nodeId);
    }
  }
});

function createFixture(
  initial: OpenClawConfig = {},
  pairingOptions: Pick<
    NonNullable<ConstructorParameters<typeof NodeRegistry>[0]>,
    "resolveCurrentPairingState"
  > = {},
) {
  let config = initial;
  const registry = new NodeRegistry({ ...pairingOptions, getConfig: () => config });
  registries.push(registry);
  const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  const client = {
    connId: "policy-conn",
    socket,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "linux",
        deviceFamily: "Linux",
        mode: "node",
      },
      device: { id: "policy-node" },
      caps: ["computer"],
      commands: ["computer.act", "system.run"],
      declaredCaps: ["computer", "screen"],
      declaredCommands: ["computer.act", "system.run", "screen.snapshot"],
    },
  } as unknown as GatewayWsClient;
  const node = registry.register(client, { ...registration });
  return {
    registry,
    node,
    client,
    socket,
    registerSurface: (caps: string[], declared: string[], approved: string[], withheld = false) => {
      Object.assign(client.connect, {
        caps: withheld ? [] : caps,
        commands: withheld ? [] : approved,
        declaredCaps: caps,
        declaredCommands: declared,
        sessionCapsCeiling: caps,
        sessionCommandsCeiling: declared,
      });
      return registry.register(client, {
        ...registration,
        approvedSurface: { caps, commands: approved },
      });
    },
    invoke: (
      opts: Omit<Parameters<NodeRegistry["invoke"]>[0], "nodeId" | "command" | "timeoutMs">,
    ) => registry.invoke({ nodeId: node.nodeId, command: "system.run", timeoutMs: 0, ...opts }),
    progress: (invokeId: string, chunk: string) =>
      registry.handleInvokeProgress({
        invokeId,
        nodeId: node.nodeId,
        connId: node.connId,
        seq: 0,
        chunk,
      }),
    getConfig: () => config,
    publishConfig: (next: OpenClawConfig) => {
      config = next;
    },
    reload: (next: OpenClawConfig) => {
      config = next;
      registry.refreshRuntimePolicy(next);
    },
  };
}

function readCommandState(node: NodeSession, config: OpenClawConfig, command: string) {
  return resolveRequiredNodeCommandAuthority({
    nodeId: node.nodeId,
    requiredCommands: [command],
    declaredCommands: node.declaredCommands,
    effectiveCommands: node.commands,
    withheldCommands: readNodeSessionWithheldCommands(node),
    allowlist: resolveNodeCommandAllowlist(config, node),
  })?.state;
}

describe("connected node runtime policy", () => {
  it.each([
    ["system.run", [], [], "pending-approval"],
    ["screen.snapshot", ["screen"], [], "pending-approval"],
    ["computer.act", ["computer"], [], "pending-approval"],
    ["camera.list", ["camera"], ["camera.list"], "pending-approval"],
    ["location.get", ["location"], ["location.get"], "pending-approval"],
    ["talk.ptt.start", [], [], "pending-approval"],
    ["camera.snap", [], [], "unauthorized"],
    ["camera.snap", [], ["camera.snap"], "pending-approval"],
    [
      NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      [],
      [NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND],
      "unauthorized",
    ],
  ] satisfies Array<[string, string[], string[], string]>)(
    "classifies an unapproved %s (caps=%j, allow=%j) as %s",
    (command, caps, allow, state) => {
      const config = policy({ commands: { allow } });
      const { registerSurface, socket } = createFixture(config);
      const node = registerSurface(caps, [command], []);

      expect(readCommandState(node, config, command)).toBe(state);
      expect(node).toMatchObject({ commands: [], caps: [] });
      expect(socket.close).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "command-only advertisement", caps: [], initiallyDenied: false },
    { name: "initially denied approved declaration", caps: [], initiallyDenied: true },
    { name: "Talk capability advertisement", caps: ["talk"], initiallyDenied: true },
  ])("restores approved Talk commands for a $name", ({ caps, initiallyDenied }) => {
    const denied = policy({ commands: { deny: TALK_PTT_COMMANDS } });
    const approvedCommands = ["talk.ptt.start", "talk.ptt.stop"];
    const { registerSurface, socket, reload } = createFixture(initiallyDenied ? denied : {});
    const node = registerSurface(caps, TALK_PTT_COMMANDS, approvedCommands, initiallyDenied);
    if (!initiallyDenied) {
      expect(node.commands).toEqual(approvedCommands);
      reload(denied);
    }
    expect(node.commands).toEqual([]);

    reload({});

    expect(node).toMatchObject({
      commands: approvedCommands,
      caps,
      pairingGeneration: "policy-generation",
    });
    expect(socket.close).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "committed unstreamed", streamed: false, speculative: false },
    { mode: "committed streamed", streamed: true, speculative: false },
    { mode: "speculative then committed", streamed: true, speculative: true },
  ])(
    "revokes pending work only under committed policy: $mode",
    async ({ streamed, speculative }) => {
      const { registry, node, reload, socket, invoke, progress, publishConfig } = createFixture();
      let invokeId = "";
      const onProgress = vi.fn();
      const result = invoke({
        ...(streamed ? { onProgress } : {}),
        onDispatchReady: (id) => {
          invokeId = id;
        },
      });
      expect(invokeId).not.toBe("");
      const candidate = speculative
        ? policy({
            commands: { deny: ["system.run"] },
            pluginTools: { enabled: false },
            allowSkills: false,
          })
        : denyRun;
      if (speculative) {
        publishConfig(candidate);
        registry.refreshRuntimePolicy();
        registry.updateNodePluginTools(node.nodeId, node.connId, [nodeTool]);
        registry.updateNodeSkills(node.nodeId, node.connId, [nodeSkill]);
        expect(node.nodePluginTools.map((tool) => tool.name)).toEqual(["node_exec"]);
        expect(node.nodeSkills.map((skill) => skill.name)).toEqual(["node-work"]);
      }
      registry.sendInvokeInput(invokeId, { input: "before-commit" });
      if (speculative) {
        expect(progress(invokeId, "before-commit")).toBe(true);
        expect(onProgress).toHaveBeenCalledWith("before-commit");
      }
      reload(candidate);
      if (speculative) {
        expect(node).toMatchObject({ nodePluginTools: [], nodeSkills: [] });
      }
      expect(() => registry.sendInvokeInput(invokeId, { input: "after-commit" })).toThrow(
        speculative ? /not pending/ : /not pending|not authorized|unavailable/,
      );
      expect(await result).toMatchObject({ ok: false, error: { code: "POLICY_CHANGED" } });
      if (!speculative) {
        expect(socket.send.mock.calls.map(([frame]) => String(frame))).toContainEqual(
          expect.stringContaining('"event":"node.invoke.cancel"'),
        );
        expect(progress(invokeId, "after-revocation")).toBe(false);
        expect(onProgress).not.toHaveBeenCalled();
        expect(
          registry.handleInvokeResult({
            id: invokeId,
            nodeId: node.nodeId,
            connId: node.connId,
            ok: true,
          }),
        ).toBe(false);
        reload({});
        expect(() => registry.sendInvokeInput(invokeId, { input: "after-restoration" })).toThrow(
          /not pending/,
        );
        expect(socket.close).not.toHaveBeenCalled();
      }
    },
  );

  it("rechecks command policy after awaited pairing work before creating a pending invocation", async () => {
    const entered = createDeferred();
    const pairing = createDeferred<{ identity: string; generation: string }>();
    const { registry, node, reload, invoke } = createFixture(
      {},
      {
        resolveCurrentPairingState: async () => {
          entered.resolve();
          return await pairing.promise;
        },
      },
    );
    const onDispatchReady = vi.fn((id: string) => {
      registry.handleInvokeResult({
        id,
        nodeId: node.nodeId,
        connId: node.connId,
        ok: false,
        error: { code: "UNEXPECTED_DISPATCH" },
      });
    });
    const result = invoke({
      onDispatchReady,
    });
    await entered.promise;
    reload(denyRun);
    pairing.resolve(pairingState);

    expect(await result).toMatchObject({ ok: false, error: { code: "POLICY_CHANGED" } });
    expect(onDispatchReady).not.toHaveBeenCalled();
  });

  it("uses the authenticated approval and restores policy-withheld commands within the protocol ceiling", () => {
    const { registry, client, reload } = createFixture(denyComputer);
    Object.assign(client.connect, {
      caps: [],
      commands: [],
      declaredCaps: [],
      declaredCommands: [],
      sessionCapsCeiling: ["computer"],
      sessionCommandsCeiling: ["computer.act"],
      declaredPermissions: { accessibility: true },
      permissions: { accessibility: true },
    });
    const node = registry.register(client, {
      ...registration,
      approvedSurface: {
        caps: ["computer", "screen"],
        commands: ["computer.act", "screen.snapshot"],
        permissions: { accessibility: false },
      },
    });
    expect(node).toMatchObject({ commands: [], permissions: { accessibility: false } });

    reload({});
    expect(node).toMatchObject({ commands: ["computer.act"], caps: ["computer"] });
    expect(client.connect.permissions).toEqual({ accessibility: false });
  });

  it("withdraws and restores approved commands without granting an unapproved declaration", () => {
    const { node, client, socket, reload, getConfig } = createFixture();
    expect(readCommandState(node, getConfig(), "computer.act")).toBe("invocable");
    expect(readCommandState(node, getConfig(), "screen.snapshot")).toBe("pending-approval");
    reload(denyComputer);

    expect(node).toMatchObject({ commands: ["system.run"], caps: [] });
    expect(client.connect.commands).toEqual(["system.run"]);
    expect(readNodeSessionWithheldCommands(node)).toContain("computer.act");
    expect(readCommandState(node, getConfig(), "computer.act")).toBe("unauthorized");
    expect(readCommandState(node, getConfig(), "screen.snapshot")).toBe("pending-approval");

    reload(policy({ commands: { allow: ["screen.snapshot"] } }));

    expect(node).toMatchObject({ commands: ["computer.act", "system.run"], caps: ["computer"] });
    expect(readNodeSessionWithheldCommands(node)).not.toContain("computer.act");
    expect(readCommandState(node, getConfig(), "computer.act")).toBe("invocable");
    expect(readCommandState(node, getConfig(), "screen.snapshot")).toBe("pending-approval");
    expect(node).toMatchObject({ connId: "policy-conn", pairingGeneration: "policy-generation" });
    expect(socket.close).not.toHaveBeenCalled();
  });

  it.each(["tools", "skills"] as const)(
    "retains disabled %s publications and restores only approved commands",
    (kind) => {
      const tools = kind === "tools";
      const disabled = policy(tools ? { pluginTools: { enabled: false } } : { allowSkills: false });
      const { registry, node, reload } = createFixture(disabled);
      const name = tools ? "node_exec" : "node-work";
      const publish = (present: boolean) => {
        if (tools) {
          registry.updateNodePluginTools(node.nodeId, node.connId, present ? nodeTools : []);
        } else {
          registry.updateNodeSkills(node.nodeId, node.connId, present ? [nodeSkill] : []);
        }
      };
      const visible = () =>
        tools
          ? listConnectedNodePluginTools().map((tool) => tool.descriptor.name)
          : mergeRemoteNodeSkillEntries([], { canExec: true }).map((entry) => entry.skill.name);
      const resident = () =>
        tools
          ? node.nodePluginTools.map((tool) => tool.name)
          : node.nodeSkills.map((skill) => skill.name);

      publish(true);
      expect(tools ? visible() : resident()).toEqual([]);
      reload({});
      expect(visible()).toEqual([name]);
      reload(denyRun);
      expect(visible()).toEqual([]);
      reload({});
      expect(resident()).toEqual([name]);
      if (!tools) {
        reload(disabled);
        expect(visible()).toEqual([]);
      }
      publish(false);
      reload({});
      expect(tools ? visible() : resident()).toEqual([]);
    },
  );
});
