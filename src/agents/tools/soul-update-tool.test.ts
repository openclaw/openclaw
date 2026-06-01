import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SOUL_FILENAME } from "../workspace.js";
import { ToolInputError } from "./common.js";
import { createSoulUpdateTool, SOUL_UPDATE_TOOL_NAME } from "./soul-update-tool.js";

let workspaceDir: string;
let soulPath: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-soul-update-tool-"));
  soulPath = path.join(workspaceDir, DEFAULT_SOUL_FILENAME);
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

async function readSoul(): Promise<string> {
  return fsp.readFile(soulPath, "utf-8");
}

describe("createSoulUpdateTool", () => {
  it("exposes the canonical tool name", () => {
    const tool = createSoulUpdateTool({ workspaceDir });
    expect(tool.name).toBe(SOUL_UPDATE_TOOL_NAME);
    expect(SOUL_UPDATE_TOOL_NAME).toBe("soul_update");
  });

  it("appends a rule and returns a forced-notice payload", async () => {
    await fsp.writeFile(soulPath, "# SOUL.md\n", "utf-8");
    const tool = createSoulUpdateTool({ workspaceDir });

    const result = await tool.execute("call-1", { rule: "Never use em-dashes." });

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload).toMatchObject({
      status: "appended",
      rule: "Never use em-dashes.",
      sectionCreated: true,
      notice: "Added to SOUL.md: 'Never use em-dashes.'",
    });
    expect(await readSoul()).toContain("- Never use em-dashes.");
  });

  it("returns noop without touching SOUL.md when noop=true", async () => {
    await fsp.writeFile(soulPath, "# SOUL.md\n", "utf-8");
    const tool = createSoulUpdateTool({ workspaceDir });

    const result = await tool.execute("call-1", { noop: true });

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload).toEqual({ status: "noop" });
    expect(await readSoul()).toBe("# SOUL.md\n");
  });

  it("returns duplicate status when the rule already exists", async () => {
    await fsp.writeFile(soulPath, "# SOUL.md\n", "utf-8");
    const tool = createSoulUpdateTool({ workspaceDir });

    await tool.execute("call-1", { rule: "Be terse." });
    const result = await tool.execute("call-2", { rule: "be terse." });

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload).toMatchObject({ status: "duplicate" });
  });

  it("rejects missing rule when noop is not set", async () => {
    const tool = createSoulUpdateTool({ workspaceDir });
    await expect(tool.execute("call-1", {})).rejects.toBeInstanceOf(ToolInputError);
  });

  it("throws ToolInputError with the failure reason when SOUL.md is missing", async () => {
    const tool = createSoulUpdateTool({ workspaceDir });
    await expect(tool.execute("call-1", { rule: "anything" })).rejects.toThrow(/soul-missing/);
  });

  it("forwards evidence to the underlying entry", async () => {
    await fsp.writeFile(soulPath, "# SOUL.md\n", "utf-8");
    const tool = createSoulUpdateTool({ workspaceDir });

    await tool.execute("call-1", {
      rule: "Avoid emoji in finance threads.",
      evidence: "User asked twice on 2026-05-12.",
    });

    expect(await readSoul()).toContain("evidence: User asked twice on 2026-05-12.");
  });
});
