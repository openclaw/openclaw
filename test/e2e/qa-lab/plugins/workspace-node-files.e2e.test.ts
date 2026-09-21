// Exercise document RPCs through the registered workspace service and node wire.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { stopChildProcess } from "../../../helpers/stop-child-process.js";

const COMMANDS = ["file.fetch", "file.stat", "file.write", "file.create"];
const ATTACHMENT_FIXTURE = "workspace-attachment-fixture";

// Invoke the public preparation caller inside the built Gateway. Only the turn
// trigger is synthetic; workspace service, policy, pairing and binary wire are real.
async function writeAttachmentFixture(root: string): Promise<string> {
  const directory = path.join(root, ATTACHMENT_FIXTURE);
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: ATTACHMENT_FIXTURE,
      version: "0.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: ATTACHMENT_FIXTURE,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(directory, "index.js"),
    `
    import path from "node:path";
    import { getAgentWorkspaceAccess, prepareAgentWorkspaceAttachments } from "openclaw/plugin-sdk/agent-workspace-runtime";
    import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
    const saved = new Map();
    export default {
      id: "${ATTACHMENT_FIXTURE}",
      register(api) {
        api.registerGatewayMethod("workspace-attachment-fixture.readOutput", async ({ params, respond }) => {
          try {
            const workspace = api.runtime.agent.resolveAgentWorkspaceDir(api.config, "qa");
            const reader = getAgentWorkspaceAccess(workspace)?.outboundMedia;
            if (!reader) throw new Error("Output reader unavailable");
            const name = params.large ? "large.bin" : "report.txt";
            const source = path.join(workspace, params.outside ? "private.txt" : "media/outbound/" + name);
            const bytes = await reader.readFile(source, params.large ? 32 * 1024 * 1024 : 1024 * 1024);
            const attachment = await saveMediaBuffer(bytes, "text/plain", "outbound", bytes.length, name);
            respond(true, { path: attachment.path });
          } catch (error) {
            respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
          }
        }, { scope: "operator.admin" });
        api.registerGatewayMethod("workspace-attachment-fixture.prepare", async ({ params, respond }) => {
          try {
            const size = params.size;
            if (size !== 17 && size !== 50) throw new Error("Unknown fixture size");
            if (!saved.has(size)) {
              const bytes = Buffer.alloc(size * 1024 * 1024, 0x6d);
              saved.set(size, await saveMediaBuffer(bytes, "application/octet-stream", "inbound", bytes.length, "report.bin"));
            }
            const source = saved.get(size).path;
            const turn = { media: [{ path: source }], timeoutMs: 60000 };
            const original = JSON.stringify(turn);
            const note = await prepareAgentWorkspaceAttachments({
              workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(api.config, "qa"),
              turn, assertCurrent: () => {},
            });
            respond(true, { note, source, unchanged: JSON.stringify(turn) === original });
          } catch (error) {
            respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
          }
        }, { scope: "operator.admin" });
      },
    };
  `,
  );
  return directory;
}

describe("node workspace document access", () => {
  it(
    "preserves reader access and live edits across node restarts without using the Gateway copy",
    { timeout: 180_000 },
    async () => {
      const state = await createOpenClawTestState({
        label: "workspace-node-files",
        layout: "home",
        applyEnv: false,
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_FAST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        },
      });
      const remote = path.join(await fs.realpath(state.root), "harness");
      await fs.mkdir(remote);
      await fs.mkdir(state.workspaceDir, { recursive: true });
      const document = path.join(remote, "AGENTS.md");
      const localDocument = path.join(state.workspaceDir, "AGENTS.md");
      await fs.writeFile(document, "Harness instructions");
      await fs.writeFile(localDocument, "Stale Gateway copy");
      const nodeIdentity = loadOrCreateDeviceIdentity({ env: state.env });
      await state.writeConfig({
        plugins: {
          allow: ["file-transfer"],
          slots: { memory: "none" },
          entries: { "file-transfer": { enabled: true } },
        },
      });
      const nodeId = nodeIdentity.deviceId;
      const attachmentFixture = await writeAttachmentFixture(state.root);
      const config: OpenClawConfig = {
        gateway: {
          mode: "local",
          bind: "loopback",
          controlUi: { enabled: false },
          nodes: { commands: { allow: COMMANDS } },
        },
        agents: {
          list: [
            { id: "qa", default: true, workspace: state.workspaceDir },
            { id: "local", workspace: state.path("local-workspace") },
          ],
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
          },
        },
        plugins: {
          allow: ["file-transfer", ATTACHMENT_FIXTURE],
          load: { paths: [attachmentFixture] },
          slots: { memory: "none" },
          entries: {
            [ATTACHMENT_FIXTURE]: { enabled: true },
            "file-transfer": {
              enabled: true,
              config: {
                policyVersion: 2,
                workspaces: { qa: { nodeId, remoteRoot: remote } },
                nodes: {
                  [nodeId]: {
                    ask: "off",
                    allowReadPaths: [
                      document,
                      `${remote}/media/inbound/openclaw-staged-*`,
                      `${remote}/media/inbound/openclaw-staged-*/**`,
                      `${remote}/media/outbound/**`,
                    ],
                    allowWritePaths: [document, `${remote}/media/inbound/openclaw-staged-*/**`],
                    followSymlinks: false,
                  },
                },
              },
            },
          },
        },
      };
      const gatewayOwner = createQaGatewayChild();
      let owner: GatewayClient | undefined;
      let reader: GatewayClient | undefined;
      let node: ChildProcess | undefined;
      let nodeOutput = "";
      try {
        // Run the built host and built plugin together. Mixing a source Gateway
        // with a packaged plugin creates two separate workspace registries.
        const gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("openclaw.mjs")],
            cwd: process.cwd(),
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1:1",
          enabledPluginIds: ["file-transfer", ATTACHMENT_FIXTURE],
          controlUiEnabled: false,
          mutateConfig: (cfg) => ({
            ...cfg,
            gateway: { ...cfg.gateway, nodes: config.gateway!.nodes },
            agents: config.agents,
            plugins: config.plugins,
          }),
        });
        const connection = { url: gateway.wsUrl, token: gateway.token, timeoutMs: 60_000 };
        owner = await connectGatewayClient({
          ...connection,
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
          deviceIdentity: loadOrCreateDeviceIdentity({ path: state.path("owner.sqlite") }),
        });
        reader = await connectGatewayClient({
          ...connection,
          scopes: ["operator.read"],
          deviceIdentity: loadOrCreateDeviceIdentity({ path: state.path("reader.sqlite") }),
        });
        const setup = await owner.request<{ setupCode: string; setupId: string }>(
          "device.pair.setupCode",
          { bootstrapProfile: "node", includeQr: false, publicUrl: gateway.wsUrl },
        );
        // Exercise the shipped node launcher and plugin dispatch. The node gets
        // only its setup code; setupStatus below verifies that code was redeemed.
        const startNode = (setupCode?: string) => {
          nodeOutput = "";
          node = spawn(
            process.execPath,
            [
              path.resolve("openclaw.mjs"),
              "node",
              "run",
              ...(setupCode ? ["--pair-if-needed", setupCode] : []),
              "--commands",
              COMMANDS.join(","),
            ],
            { cwd: process.cwd(), env: state.env, stdio: ["ignore", "pipe", "pipe"] },
          );
          node.stdout?.resume();
          node.stderr?.on("data", (chunk: Buffer) => {
            nodeOutput = (nodeOutput + chunk.toString("utf8")).slice(-8192);
          });
        };
        startNode(setup.setupCode);
        await vi.waitFor(
          async () => {
            expect(node!.exitCode, nodeOutput).toBeNull();
            const result = await owner!.request<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>("node.list", {});
            expect(result.nodes?.some((entry) => entry.nodeId === nodeId && entry.connected)).toBe(
              true,
            );
          },
          { timeout: 15_000 },
        );

        await vi.waitFor(async () => {
          expect(
            await owner!.request("device.pair.setupStatus", { setupId: setup.setupId }),
          ).toMatchObject({ completion: { deviceId: nodeId } });
        });

        const get = () =>
          reader!.request<{ file: { content: string; hash: string } }>("agents.files.get", {
            agentId: "qa",
            name: "AGENTS.md",
          });
        const opened = await get();
        expect(opened.file.content).toBe("Harness instructions");
        await expect(
          reader.request("agents.files.set", {
            agentId: "qa",
            name: "AGENTS.md",
            content: "denied",
          }),
        ).rejects.toThrow(/scope|permission/i);
        await expect(
          reader.request("node.invoke", {
            nodeId,
            command: "file.fetch",
            params: { path: document },
            idempotencyKey: "reader-direct-fetch",
          }),
        ).rejects.toThrow(/scope|permission/i);
        await owner.request("agents.files.set", {
          agentId: "qa",
          name: "AGENTS.md",
          content: "Owner edit",
          expectedHash: opened.file.hash,
        });
        expect(await fs.readFile(document, "utf8")).toBe("Owner edit");
        await fs.writeFile(document, "Harness edit");
        expect((await get()).file.content).toBe("Harness edit");
        expect(await fs.readFile(localDocument, "utf8")).toBe("Stale Gateway copy");

        for (const size of [17, 50]) {
          const prepare = () =>
            owner!.request<{ note: string; source: string; unchanged: boolean }>(
              "workspace-attachment-fixture.prepare",
              { size },
            );
          const prepared = await prepare();
          // Inbound media resolution canonicalizes the store path (e.g. /tmp on macOS).
          const source = await fs.realpath(prepared.source);
          const directory = `media/inbound/openclaw-staged-${createHash("sha256").update(source).digest("hex")}`;
          const target = path.join(remote, directory, `input-${path.basename(prepared.source)}`);
          expect(prepared.note).toBe(`[media attached: ${target}]`);
          expect(prepared.unchanged).toBe(true);
          const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
          expect(digest(await fs.readFile(target))).toBe(
            digest(Buffer.alloc(size * 1024 * 1024, 0x6d)),
          );
          await expect(fs.stat(path.join(state.workspaceDir, "media"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          await fs.writeFile(target, "Harness edited the attachment");
          expect((await prepare()).note).toBe(prepared.note);
          expect(await fs.readFile(target, "utf8")).toBe("Harness edited the attachment");
        }
        // An attachment grant must not make unrelated owner documents writable.
        await expect(
          owner.request("node.invoke", {
            nodeId,
            command: "file.write",
            params: {
              path: path.join(remote, "private.txt"),
              contentBase64: Buffer.from("denied").toString("base64"),
              overwrite: true,
              createParents: false,
            },
            idempotencyKey: "ungranted-workspace-write",
          }),
        ).rejects.toThrow(/allow|denied|permission/i);
        await expect(fs.stat(path.join(remote, "private.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        // Exercise the public output reader through the built service and node,
        // with only the permitted output folder readable and a stale local decoy.
        const remoteOutput = path.join(remote, "media/outbound/report.txt");
        const localOutput = path.join(state.workspaceDir, "media/outbound/report.txt");
        await fs.mkdir(path.dirname(remoteOutput), { recursive: true });
        await fs.mkdir(path.dirname(localOutput), { recursive: true });
        await fs.writeFile(remoteOutput, "Harness output");
        await fs.writeFile(localOutput, "Stale Gateway output");
        const readOutput = async () => {
          const attachment = await owner!.request<{ path: string }>(
            "workspace-attachment-fixture.readOutput",
            {},
          );
          return await fs.readFile(attachment.path, "utf8");
        };
        expect(await readOutput()).toBe("Harness output");
        expect(await fs.readFile(localOutput, "utf8")).toBe("Stale Gateway output");
        const largeOutput = Buffer.alloc(32 * 1024 * 1024, 0x71);
        await fs.writeFile(path.join(remote, "media/outbound/large.bin"), largeOutput);
        const largeResult = await owner.request<{ path: string }>(
          "workspace-attachment-fixture.readOutput",
          { large: true },
        );
        const receivedOutput = await fs.readFile(largeResult.path);
        expect(receivedOutput.length).toBe(largeOutput.length);
        expect(createHash("sha256").update(receivedOutput).digest("hex")).toBe(
          createHash("sha256").update(largeOutput).digest("hex"),
        );

        await fs.writeFile(path.join(remote, "private.txt"), "Not an output attachment");
        await expect(
          owner.request("workspace-attachment-fixture.readOutput", { outside: true }),
        ).rejects.toThrow(/allow|denied|permission/i);

        // Saving a document also creates a missing workspace in the local path.
        // Remote ownership must preserve that behavior without using the decoy.
        await fs.rm(state.path("local-workspace"), { recursive: true, force: true });
        await fs.rm(remote, { recursive: true });
        for (const agentId of ["local", "qa"]) {
          await owner.request("agents.files.set", {
            agentId,
            name: "AGENTS.md",
            content: "Recreated workspace",
          });
        }
        expect(await fs.readFile(state.path("local-workspace", "AGENTS.md"), "utf8")).toBe(
          "Recreated workspace",
        );
        expect((await get()).file.content).toBe("Recreated workspace");
        expect(await fs.readFile(localDocument, "utf8")).toBe("Stale Gateway copy");
        await fs.mkdir(path.dirname(remoteOutput), { recursive: true });
        await fs.writeFile(remoteOutput, "Harness output after workspace recreation");

        await stopChildProcess(node!, 5_000);
        node = undefined;
        await vi.waitFor(
          async () => {
            const result = await owner!.request<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>("node.list", {});
            expect(result.nodes?.some((entry) => entry.nodeId === nodeId && entry.connected)).toBe(
              false,
            );
          },
          { timeout: 15_000 },
        );
        await expect(get()).rejects.toThrow(/node|connected|unavailable/i);
        await expect(readOutput()).rejects.toThrow(/node|connected|unavailable/i);
        expect(await fs.readFile(localDocument, "utf8")).toBe("Stale Gateway copy");

        // A setup code is single-use. Normal restarts reuse the node's saved
        // endpoint, device identity and token, without provisioning new credentials.
        startNode();
        await vi.waitFor(
          async () => {
            expect(node!.exitCode, nodeOutput).toBeNull();
            const result = await owner!.request<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>("node.list", {});
            expect(result.nodes?.some((entry) => entry.nodeId === nodeId && entry.connected)).toBe(
              true,
            );
          },
          { timeout: 15_000 },
        );
        expect((await get()).file.content).toBe("Recreated workspace");
        expect(await readOutput()).toBe("Harness output after workspace recreation");
        await owner.request("agents.files.set", {
          agentId: "qa",
          name: "AGENTS.md",
          content: "Owner edit after node restart",
        });
        expect(await fs.readFile(document, "utf8")).toBe("Owner edit after node restart");

        // A supervisor may restart the same command, still carrying the consumed
        // setup code. The native client must prefer its persisted device token.
        await stopChildProcess(node!, 5_000);
        node = undefined;
        await vi.waitFor(
          async () => {
            const result = await owner!.request<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>("node.list", {});
            expect(result.nodes?.some((entry) => entry.nodeId === nodeId && entry.connected)).toBe(
              false,
            );
          },
          { timeout: 15_000 },
        );
        startNode(setup.setupCode);
        await vi.waitFor(
          async () => {
            expect(node!.exitCode, nodeOutput).toBeNull();
            const result = await owner!.request<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>("node.list", {});
            expect(result.nodes?.some((entry) => entry.nodeId === nodeId && entry.connected)).toBe(
              true,
            );
          },
          { timeout: 15_000 },
        );
        expect((await get()).file.content).toBe("Owner edit after node restart");
        expect(await fs.readFile(localDocument, "utf8")).toBe("Stale Gateway copy");
      } finally {
        if (node) {
          await stopChildProcess(node, 5_000);
        }
        for (const client of [reader, owner]) {
          if (client) {
            await disconnectGatewayClient(client);
          }
        }
        try {
          await stopQaGatewayFixture(gatewayOwner);
        } finally {
          await state.cleanup();
        }
      }
    },
  );
});
