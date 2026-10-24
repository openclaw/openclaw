import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import fileTransferPlugin from "../../../../extensions/file-transfer/index.js";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { stopChildProcess } from "../../../helpers/stop-child-process.js";
import { withNodeGateway } from "./node-gateway-fixture.js";

const COMMANDS = ["file.fetch", "file.stat", "file.write", "file.create"];
const expectFile = async (file: string, content: string) =>
  expect(await fs.readFile(file, "utf8")).toBe(content);
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });

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
    const nodePolicy = {
      ask: "off",
      allowReadPaths: [document],
      allowWritePaths: [document],
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
        enabledPluginIds: ["file-transfer"],
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          cron: { ...cfg.cron, enabled: false },
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
            },
          },
          plugins: {
            allow: ["file-transfer"],
            slots: { memory: "none" },
            entries: {
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
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: state.path(name, "client", "credentials.sqlite"),
          }),
        });
      owner = await connect(
        "owner",
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.pairing",
      );
      reader = await connect("reader", "operator.read");
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

      await fs.rm(state.path("local-workspace"), { recursive: true, force: true });
      await fs.rm(remote, { recursive: true });
      for (const agentId of ["local", "qa"]) {
        await set("Recreated workspace", { agentId });
      }
      await expectFile(state.path("local-workspace", "AGENTS.md"), "Recreated workspace");
      expect((await get()).file.content).toBe("Recreated workspace");
      await expectFile(localDocument, "Stale Gateway copy");

      await stopNode();
      await expect(get()).rejects.toThrow(/node|connected|unavailable/i);
      await expectFile(localDocument, "Stale Gateway copy");

      // Normal restarts reuse the saved endpoint, identity and token, not the single-use setup code.
      await startNode();
      expect((await get()).file.content).toBe("Recreated workspace");
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

const E2E_TIMEOUT_MS = 180_000;
const FILE_FETCH_COMMAND = "file.fetch";

it("rejects a replaced file before final I/O", { timeout: E2E_TIMEOUT_MS }, async () => {
  const command = fileTransferPlugin.nodeHostCommands?.find(
    (entry) => entry.command === FILE_FETCH_COMMAND,
  );
  if (!command) {
    throw new Error("file-transfer plugin omitted file.fetch");
  }
  let target = "",
    approvedObject = "",
    canonicalPath = "";
  let replaced = false;
  await withNodeGateway(
    {
      label: "qa-file-transfer-exact-approval",
      plugin: fileTransferPlugin,
      platform: process.platform,
      caps: ["file"],
      commands: [FILE_FETCH_COMMAND],
      config: async ({ state, nodeId }) => {
        target = path.join(state.home, "report.txt");
        approvedObject = path.join(state.home, "approved-object.txt");
        await fs.writeFile(target, "approved");
        canonicalPath = await fs.realpath(target);
        return {
          gateway: { nodes: { commands: { allow: [FILE_FETCH_COMMAND] } } },
          agents: {
            defaults: { skipBootstrap: true },
          },
          plugins: {
            allow: ["file-transfer"],
            entries: {
              "file-transfer": {
                enabled: true,
                config: {
                  policyVersion: 2,
                  nodes: { [nodeId]: { ask: "on-miss" } },
                  literalGrants: [
                    {
                      nodeId,
                      command: FILE_FETCH_COMMAND,
                      requestedPath: target,
                      canonicalPath,
                    },
                  ],
                },
              },
            },
          },
        };
      },
      onInvoke: async (frame) => {
        expect(frame.command).toBe(FILE_FETCH_COMMAND);
        const params = JSON.parse(frame.paramsJSON ?? "{}") as Record<string, unknown>;
        const result = await command.handle(frame.paramsJSON);
        if (params.preflightOnly === true && !replaced) {
          replaced = true;
          await fs.rename(target, approvedObject);
          await fs.writeFile(target, "replacement");
        }
        return result;
      },
    },
    async ({ operator, nodeId, invocations }) => {
      const result = await operator.request<{
        payload?: { ok?: boolean; code?: string };
      }>("node.invoke", {
        nodeId,
        command: FILE_FETCH_COMMAND,
        params: { path: target },
        timeoutMs: 60_000,
        idempotencyKey: randomUUID(),
      });

      expect(
        invocations.map(({ command: invokedCommand, params }) => ({
          command: invokedCommand,
          params,
        })),
      ).toEqual(
        [
          { preflightOnly: true, followSymlinks: false },
          { expectedBinding: expect.objectContaining({ kind: "existing" }) },
        ].map((params) => ({
          command: FILE_FETCH_COMMAND,
          params: expect.objectContaining({
            path: target,
            expectedCanonicalPath: canonicalPath,
            ...params,
          }),
        })),
      );
      expect(result.payload).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
      await expect(fs.readFile(approvedObject, "utf8")).resolves.toBe("approved");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    },
  );
});
