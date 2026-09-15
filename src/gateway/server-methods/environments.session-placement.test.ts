import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../../agents/harness/registry.test-support.js";
import { listNodePairing } from "../../infra/device-pairing-node.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { NodeRegistry } from "../node-registry.js";
import {
  SESSION_PLACEMENT_PREPARED_AUTH_REASON,
  SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON,
} from "../worker-environments/device-placement-eligibility.js";
import { environmentsHandlers } from "./environments.js";

const registries: NodeRegistry[] = [];
const tempRoots: string[] = [];
let registeredHarnesses = listRegisteredAgentHarnesses();

afterEach(async () => {
  for (const registry of registries.splice(0)) {
    for (const node of registry.listConnected()) {
      registry.unregister(node.connId);
    }
  }
  restoreRegisteredAgentHarnesses(registeredHarnesses);
  registeredHarnesses = listRegisteredAgentHarnesses();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
  vi.restoreAllMocks();
});

vi.mock("../../infra/device-pairing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/device-pairing.js")>();
  return {
    ...actual,
    listDevicePairing: vi.fn(),
  };
});

vi.mock("../../infra/device-pairing-node.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/device-pairing-node.js")>();
  return {
    ...actual,
    listNodePairing: vi.fn(),
  };
});

beforeEach(() => {
  vi.mocked(listDevicePairing).mockResolvedValue({
    paired: [
      {
        deviceId: "node-host",
        displayName: "Build runner",
        pairedAtMs: 1,
        approvedAtMs: 1,
      },
    ],
  } as never);
  vi.mocked(listNodePairing).mockResolvedValue({ paired: [] } as never);
});

describe("environments.list session placement preflight", () => {
  it("stamps disabledReason for symlink + prepared-auth blockers on node rows", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-env-list-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-env-list-outside-"));
    tempRoots.push(workspace, outside);
    await fs.symlink(outside, path.join(workspace, "escape"));

    registeredHarnesses = listRegisteredAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      autoSelection: { providerIds: ["openai"] },
      supports: () => ({ supported: true }),
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["codex.exec-server.stdio.v1"],
          consumesWorkerSlot: false,
        },
      },
      runAttempt: async () => {
        throw new Error("list preflight must not execute");
      },
    });

    const config = {
      gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
      plugins: { entries: { codex: { config: { appServer: { homeScope: "user" } } } } },
    };
    const registry = new NodeRegistry({ getConfig: () => config });
    registries.push(registry);
    const node = registry.register(
      {
        connId: "conn-host",
        socket: { readyState: 1, bufferedAmount: 0, send: vi.fn() },
        connect: {
          client: {
            id: "node-host",
            mode: "node",
            displayName: "Build runner",
            platform: "darwin",
          },
          device: { id: "node-host" },
          caps: ["session.host"],
          declaredCommands: ["codex.exec-server.stdio.v1"],
          commands: ["codex.exec-server.stdio.v1"],
        },
      } as never,
      { pairingIdentity: "node-host" },
    );
    vi.spyOn(registry, "listConnectedForPairingStates").mockReturnValue([node]);
    const respond = vi.fn();
    await environmentsHandlers["environments.list"]({
      params: { runtimeId: "codex", workspacePath: workspace },
      respond,
      client: { connect: { scopes: ["operator.write"] } },
      context: {
        logGateway: { warn: vi.fn() },
        getRuntimeConfig: () => config,
        nodeRegistry: registry,
      },
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionPlacement: {
          workspaceHasEscapingSymlinks: true,
          missingPreparedAuth: true,
        },
        environments: expect.arrayContaining([
          expect.objectContaining({
            id: "node:node-host",
            disabledReason: `${SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON} ${SESSION_PLACEMENT_PREPARED_AUTH_REASON}`,
          }),
        ]),
      }),
      undefined,
    );
  });
});
