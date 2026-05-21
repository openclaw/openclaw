import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createSaveSecretTool } from "./save-secret-tool.js";

describe("save_secret tool", () => {
  it("is registered as a runtime producer for lab-chat secret_payload", () => {
    const tools = createOpenClawTools({ disablePluginTools: true, senderIsOwner: true });
    const tool = tools.find((candidate) => candidate.name === "save_secret");
    expect(tool).toBeDefined();
    expect(tool?.ownerOnly).toBe(true);
  });

  it("returns only metadata and the tool_use_id, never the secret value", async () => {
    const tool = createSaveSecretTool();
    const result = await tool.execute("toolu_save_1", {
      name: "DEPLOY_KEY",
      category: "ssh_key",
      description: "Deploy key for production.",
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain("toolu_save_1");
    expect(serialized).toContain("DEPLOY_KEY");
    expect(serialized).not.toContain("CANARY_SECRET_VALUE");
    expect(result.details).toEqual({
      status: "awaiting_secret_payload",
      tool_use_id: "toolu_save_1",
      secret: {
        name: "DEPLOY_KEY",
        category: "ssh_key",
        description: "Deploy key for production.",
      },
    });
  });

  it("rejects inline secret values so only the control frame can carry plaintext", async () => {
    const tool = createSaveSecretTool();
    await expect(
      tool.execute("toolu_save_2", {
        name: "DEPLOY_KEY",
        category: "ssh_key",
        value: "CANARY_SECRET_VALUE",
      }),
    ).rejects.toThrow(/never accepts a secret value/);
  });
});
