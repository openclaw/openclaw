import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
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
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const expectFile = async (file: string, content: string) =>
  expect(await fs.readFile(file, "utf8")).toBe(content);
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });

// Only the trigger is synthetic; workspace service, policy, pairing and binary wire are real.
async function writeAttachmentFixture(root: string): Promise<string> {
  const directory = path.join(root, ATTACHMENT_FIXTURE);
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: ATTACHMENT_FIXTURE,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const source = `
    import path from "node:path";
    import { getAgentWorkspaceAccess, prepareAgentWorkspaceAttachments } from "openclaw/plugin-sdk/agent-workspace-runtime";
    import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
    const saved = new Map();
    export default {
      id: "${ATTACHMENT_FIXTURE}",
      register(api) {
        api.registerGatewayMethod("workspace-attachment-fixture.run", async ({ params: { size, large, outside }, respond }) => {
          try {
            const workspace = api.runtime.agent.resolveAgentWorkspaceDir(api.config, "qa");
            if (size !== undefined) {
              if (size !== 17 && size !== 50) throw new Error("Unknown fixture size");
              if (!saved.has(size)) {
                const bytes = Buffer.alloc(size * 1024 * 1024, 0x6d);
                saved.set(size, await saveMediaBuffer(bytes, "application/octet-stream", "inbound", bytes.length, "report.bin"));
              }
              const source = saved.get(size).path;
              const turn = { media: [{ path: source }], timeoutMs: 60000 };
              const original = JSON.stringify(turn);
              const note = await prepareAgentWorkspaceAttachments({ workspaceDir: workspace, turn, assertCurrent: () => {} });
              return respond(true, { note, source, unchanged: JSON.stringify(turn) === original });
            }
            const reader = getAgentWorkspaceAccess(workspace)?.outboundMedia;
            if (!reader) throw new Error("Output reader unavailable");
            const name = large ? "large.bin" : "report.txt";
            const source = path.join(workspace, outside ? "private.txt" : "media/outbound/" + name);
            const bytes = await reader.readFile(source, large ? 32 * 1024 * 1024 : 1024 * 1024);
            const attachment = await saveMediaBuffer(bytes, "text/plain", "outbound", bytes.length, name);
            respond(true, { path: attachment.path });
          } catch (error) {
            respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
          }
        }, { scope: "operator.admin" });
      },
    };
  `;
  await fs.writeFile(path.join(directory, "index.mjs"), source);
  return directory;
}

it(
  "node workspace document access preserves reader access and live edits across node restarts without using the Gateway copy",
  { timeout: 180_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "workspace-node-files",
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
    const staged = `${remote}/media/inbound/openclaw-staged-*`;
    const nodePolicy = {
      ask: "off",
      allowReadPaths: [document, staged, `${staged}/**`, `${remote}/media/outbound/**`],
      allowWritePaths: [document, `${staged}/**`],
      followSymlinks: false,
    };
    await fs.writeFile(document, "Harness instructions");
    await fs.writeFile(localDocument, "Stale Gateway copy");
    const nodeId = loadOrCreateDeviceIdentity({ env: state.env }).deviceId;
    await state.writeConfig({
      plugins: {
        allow: ["file-transfer"],
        slots: { memory: "none" },
        entries: { "file-transfer": { enabled: true } },
      },
    });
    const attachmentFixture = await writeAttachmentFixture(state.root);
    const gatewayOwner = createQaGatewayChild();
    let owner: GatewayClient | undefined;
    let reader: GatewayClient | undefined;
    let node: ChildProcess | undefined;
    let nodeOutput = "";
    try {
      // A source host and packaged plugin would have separate workspace registries.
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
          gateway: { ...cfg.gateway, nodes: { commands: { allow: COMMANDS } } },
          agents: {
            ownership: "explicit",
            entries: {
              qa: { workspace: state.workspaceDir },
              local: { workspace: state.path("local-workspace") },
            },
            defaults: {
              workspace: state.workspaceDir,
              systemAgent: { agentId: "qa" },
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
                  nodes: { [nodeId]: nodePolicy },
                },
              },
            },
          },
        }),
      });
      const connect = (name: string, ...scopes: string[]) =>
        connectGatewayClient({
          url: gateway.wsUrl,
          token: gateway.token,
          timeoutMs: 60_000,
          scopes,
          deviceIdentity: loadOrCreateDeviceIdentity({ path: state.path(`${name}.sqlite`) }),
        });
      owner = await connect(
        "owner",
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.pairing",
      );
      reader = await connect("reader", "operator.read");
      const fixture = <T>(params: object = {}) =>
        owner!.request<T>(`${ATTACHMENT_FIXTURE}.run`, params);
      const setup = await owner.request<{ setupCode: string; setupId: string }>(
        "device.pair.setupCode",
        { bootstrapProfile: "node", includeQr: false, publicUrl: gateway.wsUrl },
      );
      const startNode = async (setupCode?: string) => {
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
        await waitForNode(true);
      };
      const waitForNode = (connected: boolean) =>
        vi.waitFor(
          async () => {
            if (connected) {
              expect(node!.exitCode, nodeOutput).toBeNull();
            }
            const result = await owner!.request<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>("node.list", {});
            expect(result.nodes?.some((entry) => entry.nodeId === nodeId && entry.connected)).toBe(
              connected,
            );
          },
          { timeout: 15_000 },
        );
      const stopNode = async () => {
        await stopChildProcess(node!, 5_000);
        node = undefined;
        await waitForNode(false);
      };
      await startNode(setup.setupCode);
      await vi.waitFor(async () => {
        expect(
          await owner!.request("device.pair.setupStatus", { setupId: setup.setupId }),
        ).toMatchObject({ completion: { deviceId: nodeId } });
      });
      const fileParams = { agentId: "qa", name: "AGENTS.md" };
      const get = () =>
        reader!.request<{ file: { content: string; hash: string } }>(
          "agents.files.get",
          fileParams,
        );
      const set = (content: string, overrides: { agentId?: string; expectedHash?: string } = {}) =>
        owner!.request("agents.files.set", { ...fileParams, content, ...overrides });
      const opened = await get();
      expect(opened.file.content).toBe("Harness instructions");
      await expect(
        reader.request("agents.files.set", { ...fileParams, content: "denied" }),
      ).rejects.toThrow(/scope|permission/i);
      await expect(
        reader.request("node.invoke", {
          nodeId,
          command: "file.fetch",
          params: { path: document },
          idempotencyKey: "reader-direct-fetch",
        }),
      ).rejects.toThrow(/scope|permission/i);
      await set("Owner edit", { expectedHash: opened.file.hash });
      await expectFile(document, "Owner edit");
      await fs.writeFile(document, "Harness edit");
      expect((await get()).file.content).toBe("Harness edit");
      await expectFile(localDocument, "Stale Gateway copy");

      for (const size of [17, 50]) {
        const prepare = () =>
          fixture<{ note: string; source: string; unchanged: boolean }>({ size });
        const prepared = await prepare();
        // Inbound media resolution canonicalizes the store path (e.g. /tmp on macOS).
        const source = await fs.realpath(prepared.source);
        const directory = `media/inbound/openclaw-staged-${digest(source)}`;
        const target = path.join(remote, directory, `input-${path.basename(prepared.source)}`);
        expect(prepared).toMatchObject({ note: `[media attached: ${target}]`, unchanged: true });
        expect(digest(await fs.readFile(target))).toBe(
          digest(Buffer.alloc(size * 1024 * 1024, 0x6d)),
        );
        await expectMissing(path.join(state.workspaceDir, "media"));
        await fs.writeFile(target, "Harness edited the attachment");
        expect((await prepare()).note).toBe(prepared.note);
        await expectFile(target, "Harness edited the attachment");
      }
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
      await expectMissing(path.join(remote, "private.txt"));

      const remoteOutput = path.join(remote, "media/outbound/report.txt");
      const localOutput = path.join(state.workspaceDir, "media/outbound/report.txt");
      await fs.mkdir(path.dirname(remoteOutput), { recursive: true });
      await fs.mkdir(path.dirname(localOutput), { recursive: true });
      await fs.writeFile(remoteOutput, "Harness output");
      await fs.writeFile(localOutput, "Stale Gateway output");
      const readOutput = async () => fs.readFile((await fixture<{ path: string }>()).path, "utf8");
      expect(await readOutput()).toBe("Harness output");
      await expectFile(localOutput, "Stale Gateway output");
      const largeOutput = Buffer.alloc(32 * 1024 * 1024, 0x71);
      await fs.writeFile(path.join(remote, "media/outbound/large.bin"), largeOutput);
      const largeResult = await fixture<{ path: string }>({ large: true });
      expect(largeOutput.equals(await fs.readFile(largeResult.path))).toBe(true);

      await fs.writeFile(path.join(remote, "private.txt"), "Not an output attachment");
      await expect(fixture({ outside: true })).rejects.toThrow(/allow|denied|permission/i);

      await fs.rm(state.path("local-workspace"), { recursive: true, force: true });
      await fs.rm(remote, { recursive: true });
      for (const agentId of ["local", "qa"]) {
        await set("Recreated workspace", { agentId });
      }
      await expectFile(state.path("local-workspace", "AGENTS.md"), "Recreated workspace");
      expect((await get()).file.content).toBe("Recreated workspace");
      await expectFile(localDocument, "Stale Gateway copy");
      await fs.mkdir(path.dirname(remoteOutput), { recursive: true });
      await fs.writeFile(remoteOutput, "Harness output after workspace recreation");

      await stopNode();
      await expect(get()).rejects.toThrow(/node|connected|unavailable/i);
      await expect(readOutput()).rejects.toThrow(/node|connected|unavailable/i);
      await expectFile(localDocument, "Stale Gateway copy");

      // Normal restarts reuse the saved endpoint, identity and token, not the single-use setup code.
      await startNode();
      expect((await get()).file.content).toBe("Recreated workspace");
      expect(await readOutput()).toBe("Harness output after workspace recreation");
      await set("Owner edit after node restart");
      await expectFile(document, "Owner edit after node restart");

      // A supervisor may replay the consumed setup code; the saved device token must take precedence.
      await stopNode();
      await startNode(setup.setupCode);
      expect((await get()).file.content).toBe("Owner edit after node restart");
      await expectFile(localDocument, "Stale Gateway copy");
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
