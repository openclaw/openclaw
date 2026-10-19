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
      const { registry, client, socket } = createFixture(config);
      Object.assign(client.connect, {
        caps,
        commands: [],
        declaredCaps: caps,
        declaredCommands: [command],
        sessionCapsCeiling: caps,
        sessionCommandsCeiling: [command],
      });
      const node = registry.register(client, {
        ...registration,
        approvedSurface: { caps, commands: [] },
      });

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
    const { registry, client, socket, reload } = createFixture(initiallyDenied ? denied : {});
    Object.assign(client.connect, {
      caps: initiallyDenied ? [] : caps,
      commands: initiallyDenied ? [] : approvedCommands,
      declaredCaps: caps,
      declaredCommands: TALK_PTT_COMMANDS,
      sessionCapsCeiling: caps,
      sessionCommandsCeiling: TALK_PTT_COMMANDS,
    });
    const node = registry.register(client, {
      ...registration,
      approvedSurface: { caps, commands: approvedCommands },
    });
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

  it("keeps publications and pending frames on committed policy until reconciliation", async () => {
    const { registry, node, publishConfig } = createFixture();
    let invokeId = "";
    const onProgress = vi.fn();
    const result = registry.invoke({
      nodeId: node.nodeId,
      command: "system.run",
      timeoutMs: 0,
      onProgress,
      onDispatchReady: (id) => {
        invokeId = id;
      },
    });
    expect(invokeId).not.toBe("");
    const candidate = policy({
      commands: { deny: ["system.run"] },
      pluginTools: { enabled: false },
      allowSkills: false,
    });
    publishConfig(candidate);
    registry.refreshRuntimePolicy();
    registry.updateNodePluginTools(node.nodeId, node.connId, [nodeTool]);
    registry.updateNodeSkills(node.nodeId, node.connId, [nodeSkill]);

    expect(node.nodePluginTools.map((tool) => tool.name)).toEqual(["node_exec"]);
    expect(node.nodeSkills.map((skill) => skill.name)).toEqual(["node-work"]);
    registry.sendInvokeInput(invokeId, { input: "before-commit" });
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: node.nodeId,
        connId: node.connId,
        seq: 0,
        chunk: "before-commit",
      }),
    ).toBe(true);
    expect(onProgress).toHaveBeenCalledWith("before-commit");

    registry.refreshRuntimePolicy(candidate);

    expect(node.nodePluginTools).toEqual([]);
    expect(node.nodeSkills).toEqual([]);
    expect(await result).toMatchObject({ ok: false, error: { code: "POLICY_CHANGED" } });
    expect(() => registry.sendInvokeInput(invokeId, { input: "after-commit" })).toThrow(
      /not pending/,
    );
  });

  it.each([false, true])(
    "cancels a revoked active command and rejects retained input (streamed=%s)",
    async (streamed) => {
      const { registry, node, reload, socket } = createFixture();
      let invokeId = "";
      const onProgress = vi.fn();
      const result = registry.invoke({
        nodeId: node.nodeId,
        command: "system.run",
        timeoutMs: 0,
        ...(streamed ? { onProgress } : {}),
        onDispatchReady: (id) => {
          invokeId = id;
        },
      });
      expect(invokeId).not.toBe("");
      registry.sendInvokeInput(invokeId, { input: "before-revocation" });

      reload(denyRun);

      expect(() => registry.sendInvokeInput(invokeId, { input: "after-revocation" })).toThrow(
        /not pending|not authorized|unavailable/,
      );
      expect(await result).toMatchObject({ ok: false, error: { code: "POLICY_CHANGED" } });
      expect(socket.send.mock.calls.map(([frame]) => String(frame))).toContainEqual(
        expect.stringContaining('"event":"node.invoke.cancel"'),
      );
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: node.nodeId,
          connId: node.connId,
          seq: 0,
          chunk: "after-revocation",
        }),
      ).toBe(false);
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
    },
  );

  it("rechecks command policy after awaited pairing work before creating a pending invocation", async () => {
    const entered = createDeferred();
    const pairing = createDeferred<{ identity: string; generation: string }>();
    const { registry, node, reload } = createFixture(
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
    const result = registry.invoke({
      nodeId: node.nodeId,
      command: "system.run",
      timeoutMs: 0,
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

  it("retains tool publication while disabled and restores only currently approved commands", () => {
    const { registry, node, reload } = createFixture(policy({ pluginTools: { enabled: false } }));
    registry.updateNodePluginTools(node.nodeId, node.connId, [
      nodeTool,
      {
        ...nodeTool,
        name: "node_screen",
        description: "Unapproved screen command",
        command: "screen.snapshot",
      },
    ]);
    expect(listConnectedNodePluginTools()).toEqual([]);

    reload({});
    expect(listConnectedNodePluginTools().map((tool) => tool.descriptor.name)).toEqual([
      "node_exec",
    ]);

    reload(denyRun);
    expect(listConnectedNodePluginTools()).toEqual([]);
    reload({});
    expect(node.nodePluginTools.map((tool) => tool.name)).toEqual(["node_exec"]);

    registry.updateNodePluginTools(node.nodeId, node.connId, []);
    reload({});
    expect(listConnectedNodePluginTools()).toEqual([]);
  });

  it("restores the last bounded skill publication and withdraws it when execution is denied", () => {
    const { registry, node, reload } = createFixture(policy({ allowSkills: false }));
    registry.updateNodeSkills(node.nodeId, node.connId, [nodeSkill]);
    expect(node.nodeSkills).toEqual([]);

    reload({});
    expect(
      mergeRemoteNodeSkillEntries([], { canExec: true }).map((entry) => entry.skill.name),
    ).toEqual(["node-work"]);

    reload(denyRun);
    expect(mergeRemoteNodeSkillEntries([], { canExec: true })).toEqual([]);
    reload({});
    expect(node.nodeSkills.map((skill) => skill.name)).toEqual(["node-work"]);

    reload(policy({ allowSkills: false }));
    expect(mergeRemoteNodeSkillEntries([], { canExec: true })).toEqual([]);
    registry.updateNodeSkills(node.nodeId, node.connId, []);
    reload({});
    expect(node.nodeSkills).toEqual([]);
  });
});
