import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { configureZaiMcpTools } from "../zai-mcp-tools-config.js";

describe("configureZaiMcpTools", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zai-mcp-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should create mcporter.json with all Z.AI MCP tools", async () => {
    const apiKey = "test-api-key-12345";
    await configureZaiMcpTools(apiKey, tempDir);

    const configPath = path.join(tempDir, "config", "mcporter.json");
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.zread).toBeDefined();
    expect(config.mcpServers["zai-vision"]).toBeDefined();
    expect(config.mcpServers["zai-web-search"]).toBeDefined();
  });

  it("should configure zread with correct HTTP settings", async () => {
    const apiKey = "test-api-key-12345";
    await configureZaiMcpTools(apiKey, tempDir);

    const configPath = path.join(tempDir, "config", "mcporter.json");
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);

    expect(config.mcpServers.zread.baseUrl).toBe(
      "https://api.z.ai/api/mcp/zread/mcp"
    );
    expect(config.mcpServers.zread.headers.Authorization).toBe(
      `Bearer ${apiKey}`
    );
  });

  it("should configure zai-vision with stdio mode", async () => {
    const apiKey = "test-api-key-12345";
    await configureZaiMcpTools(apiKey, tempDir);

    const configPath = path.join(tempDir, "config", "mcporter.json");
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);

    expect(config.mcpServers["zai-vision"].command).toBe(
      "npx -y @z_ai/mcp-server"
    );
    expect(config.mcpServers["zai-vision"].env.Z_AI_API_KEY).toBe(apiKey);
  });

  it("should preserve existing mcpServers when merging", async () => {
    // Create existing config
    const configDir = path.join(tempDir, "config");
    await fs.mkdir(configDir, { recursive: true });
    const existingConfig = {
      mcpServers: {
        "existing-tool": {
          command: "existing-command",
        },
      },
    };
    await fs.writeFile(
      path.join(configDir, "mcporter.json"),
      JSON.stringify(existingConfig)
    );

    const apiKey = "test-api-key-12345";
    await configureZaiMcpTools(apiKey, tempDir);

    const content = await fs.readFile(
      path.join(configDir, "mcporter.json"),
      "utf-8"
    );
    const config = JSON.parse(content);

    // Existing tool should be preserved
    expect(config.mcpServers["existing-tool"]).toBeDefined();
    expect(config.mcpServers["existing-tool"].command).toBe("existing-command");
    // New tools should be added
    expect(config.mcpServers.zread).toBeDefined();
  });

  it("should handle config without mcpServers field", async () => {
    // Create existing config without mcpServers
    const configDir = path.join(tempDir, "config");
    await fs.mkdir(configDir, { recursive: true });
    const existingConfig = {
      otherField: "someValue",
    };
    await fs.writeFile(
      path.join(configDir, "mcporter.json"),
      JSON.stringify(existingConfig)
    );

    const apiKey = "test-api-key-12345";
    await configureZaiMcpTools(apiKey, tempDir);

    const content = await fs.readFile(
      path.join(configDir, "mcporter.json"),
      "utf-8"
    );
    const config = JSON.parse(content);

    // mcpServers should be created
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.zread).toBeDefined();
    // Other fields should be preserved
    expect(config.otherField).toBe("someValue");
  });

  it("should handle invalid JSON in existing config", async () => {
    const configDir = path.join(tempDir, "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "mcporter.json"),
      "invalid json {{{"
    );

    const apiKey = "test-api-key-12345";
    await configureZaiMcpTools(apiKey, tempDir);

    const content = await fs.readFile(
      path.join(configDir, "mcporter.json"),
      "utf-8"
    );
    const config = JSON.parse(content);

    // Should create valid config
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.zread).toBeDefined();
  });
});
