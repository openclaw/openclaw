// Live E2E proof for the read-only agents.workspace.* RPC pair (#100705):
// a real gateway process, a real operator WebSocket client, and the same
// requests the mobile file browsers send.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { type GatewayInstance, stopGatewayInstance } from "./helpers/gateway-e2e-harness.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const E2E_TIMEOUT_MS = 120_000;

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("agents.workspace e2e", () => {
  let gateway: GatewayInstance;
  let operator: GatewayClient;

  beforeAll(async () => {
    gateway = await createOpenClawTestInstance({ name: "workspace" });
    const workspaceDir = gateway.state.workspaceDir;
    // Pin the default agent's workspace to the harness dir so the RPCs read
    // the files this test writes, independent of env-derived defaults.
    const config = JSON.parse(await fs.readFile(gateway.configPath, "utf8")) as Record<
      string,
      { defaults?: Record<string, unknown> } | undefined
    >;
    config.agents = {
      ...config.agents,
      defaults: { ...config.agents?.defaults, workspace: workspaceDir },
    };
    await fs.writeFile(gateway.configPath, JSON.stringify(config, null, 2), "utf8");
    await gateway.startGateway();
    await fs.mkdir(path.join(workspaceDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "notes", "todo.md"), "# Todo\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "report.txt"), "hello workspace\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "pixel.png"), Buffer.from(PNG_BASE64, "base64"));
    operator = await connectGatewayClient({
      url: `ws://127.0.0.1:${gateway.port}`,
      token: gateway.gatewayToken,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: "workspace-e2e",
      clientVersion: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.CLI,
      timeoutMessage: "timeout waiting for operator client to connect",
    });
  }, E2E_TIMEOUT_MS);

  afterAll(async () => {
    operator?.stop();
    if (gateway) {
      await stopGatewayInstance(gateway);
    }
  });

  it(
    "lists, drills down, reads text and images, and rejects escapes",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const root = await operator.request<{
        path: string;
        entries: Array<{ path: string; name: string; kind: string; size?: number }>;
      }>("agents.workspace.list", { agentId: "main" });
      const names = root.entries.map((entry) => entry.name);
      expect(names).toContain("notes");
      expect(names).toContain("report.txt");
      expect(names).toContain("pixel.png");
      expect(root.entries[0]?.kind).toBe("directory");

      const nested = await operator.request<{
        path: string;
        parentPath?: string;
        entries: Array<{ path: string }>;
      }>("agents.workspace.list", { agentId: "main", path: "notes" });
      expect(nested.parentPath).toBe("");
      expect(nested.entries.map((entry) => entry.path)).toContain("notes/todo.md");

      const text = await operator.request<{
        file: { encoding: string; mimeType?: string; content: string };
      }>("agents.workspace.read", { agentId: "main", path: "report.txt" });
      expect(text.file.encoding).toBe("utf8");
      expect(text.file.content).toBe("hello workspace\n");

      const image = await operator.request<{
        file: { encoding: string; mimeType?: string; content: string };
      }>("agents.workspace.read", { agentId: "main", path: "pixel.png" });
      expect(image.file.encoding).toBe("base64");
      expect(image.file.mimeType).toBe("image/png");
      expect(image.file.content).toBe(PNG_BASE64);

      await expect(
        operator.request("agents.workspace.read", { agentId: "main", path: "../outside.txt" }),
      ).rejects.toThrow(/escapes workspace root/);
      await expect(
        operator.request("agents.workspace.read", { agentId: "main", path: "/etc/hosts" }),
      ).rejects.toThrow(/escapes workspace root/);
    },
  );
});
