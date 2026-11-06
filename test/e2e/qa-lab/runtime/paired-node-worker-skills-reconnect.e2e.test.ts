import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { prepareNodeHostRuntime } from "../../../../src/node-host/runtime.js";
import type { SkillStatusReport } from "../../../../src/skills/discovery/status.js";
import { writeSkill } from "../../../../src/skills/test-support/e2e-test-helpers.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import {
  connectWireClient,
  createPairedNodeWorkerHost,
  type PairedNodeWorkerHost,
} from "./paired-node-worker-wire-fixture.js";

it.skipIf(process.platform === "win32")(
  "reads remote skills after the paired node reconnects without reusing the lost request",
  async (context) => {
    const owner = createQaGatewayChild();
    let node: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    const disconnected = createDeferred();
    const droppedFrame = new Error("fixture discarded the request from the closed connection");
    let dropDiscovery = false;
    await runQaGatewayTestFixture(
      context,
      async ({ createTempDir }) => {
        const root = await realpath(createTempDir("workspace-skills-reconnect-"));
        const local = path.join(root, "gateway-workspace");
        const remote = path.join(root, "node-workspace");
        const nodeEnv = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "node-state") };
        const identity = loadOrCreateDeviceIdentity({ env: nodeEnv });
        await mkdir(local, { recursive: true });
        await writeSkill({
          dir: path.join(remote, "skills", "remote-only"),
          name: "remote-only",
          description: "Read from the reconnected node",
          body: "These instructions exist only on the node.",
        });
        const nodeConfig: OpenClawConfig = {
          agents: { entries: { main: { workspace: remote } } },
          plugins: { allow: ["file-transfer"], entries: { "file-transfer": { enabled: true } } },
        };
        const gateway = await owner.start({
          repoRoot: process.cwd(),
          initializeCurrentRuntimeState: true,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("dist/index.js")],
          },
          transportBaseUrl: "http://127.0.0.1:1",
          enabledPluginIds: ["file-transfer"],
          controlUiEnabled: false,
          mutateConfig: (config) => ({
            ...config,
            // This proof isolates discovery reads; persistent watcher recovery has a separate owner.
            skills: { load: { watch: false } },
            gateway: { ...config.gateway, nodes: { commands: { allow: ["workspace.skills"] } } },
            agents: {
              ownership: "explicit",
              entries: { qa: { workspace: local } },
              defaults: { workspace: local, systemAgent: { agentId: "qa" }, skipBootstrap: true },
            },
            plugins: {
              allow: ["file-transfer"],
              slots: { memory: "none" },
              entries: {
                "file-transfer": {
                  enabled: true,
                  config: {
                    policyVersion: 2,
                    workspaces: { qa: { nodeId: identity.deviceId, remoteRoot: remote } },
                    nodes: {
                      [identity.deviceId]: { allowReadPaths: [remote, remote + "/**"], ask: "off" },
                    },
                  },
                },
              },
            },
          }),
        });
        operator = await connectWireClient({ gateway, role: "operator", identity: null });
        node = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          nodeConfig,
          pluginRuntime: await prepareNodeHostRuntime({
            config: nodeConfig,
            env: { ...nodeEnv, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" },
            commands: ["workspace.skills"],
          }),
          beforeInvoke: async (frame, host) => {
            if (
              dropDiscovery &&
              frame.command === "workspace.skills" &&
              JSON.parse(frame.paramsJSON ?? "{}").operation === "discovery"
            ) {
              dropDiscovery = false;
              // Close the real socket after dispatch. Never deliver this old frame on the new connection.
              await host.disconnect();
              disconnected.resolve();
              throw droppedFrame;
            }
          },
        });
        expect(node.identity.deviceId).toBe(identity.deviceId);
        const firstFrame = node.frames.length;
        dropDiscovery = true;
        const status = operator.request<SkillStatusReport>("skills.status", { agentId: "qa" });
        // Install both observers before the socket closes; an early product failure must stay handled.
        const reconnect = withinTest(
          awaitGateBeforeSettlement(
            disconnected.promise,
            status,
            "Skill status completed before disconnection",
          ),
          context.signal,
        ).then(() => node!.connect());
        const [result, connection] = await Promise.allSettled([status, reconnect]);
        if (connection.status === "rejected") {
          throw connection.reason;
        }
        if (result.status === "rejected") {
          throw result.reason;
        }
        expect(result.value.skills).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "remote-only",
              description: "Read from the reconnected node",
              filePath: path.join(remote, "skills", "remote-only", "SKILL.md"),
            }),
          ]),
        );
        const discovery = node.frames
          .slice(firstFrame)
          .filter(
            (frame) =>
              frame.command === "workspace.skills" &&
              JSON.parse(frame.paramsJSON ?? "{}").operation === "discovery",
          );
        expect(discovery.length).toBeGreaterThanOrEqual(2);
        expect(new Set(discovery.map((frame) => frame.id)).size).toBe(discovery.length);
        expect(discovery.every((frame) => frame.nodeId === identity.deviceId)).toBe(true);
        // Success came through the real node runtime; only our deliberately discarded frame failed locally.
        expect(node.invokeErrors).toEqual([droppedFrame]);
      },
      () => node?.stop(),
      () => operator?.stopAndWait({ timeoutMs: 2_000 }),
      () => stopQaGatewayFixture(owner),
    );
  },
  180_000,
);
