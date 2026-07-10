// Gateway tests cover cheap-model tool-call title generation and its SQLite cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeWithPreparedSimpleCompletionModel = vi.hoisted(() => vi.fn());
const prepareSimpleCompletionModelForAgent = vi.hoisted(() => vi.fn());
const resolveSimpleCompletionSelectionForAgent = vi.hoisted(() => vi.fn());

vi.mock("../agents/simple-completion-runtime.js", () => ({
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
  resolveSimpleCompletionSelectionForAgent,
}));

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { generateToolCallTitles } from "./chat-tool-titles.js";

const AGENT_ID = "main";

function mockPreparedModel(): void {
  prepareSimpleCompletionModelForAgent.mockResolvedValue({
    selection: { provider: "openai", modelId: "gpt-test", agentDir: "/tmp/openclaw-agent" },
    model: { provider: "openai", id: "gpt-test", maxTokens: 8192 },
    auth: { apiKey: "k", mode: "api-key" },
  });
}

function mockCompletionTitles(titles: Record<string, string>): void {
  completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ titles }) }],
  });
}

describe("generateToolCallTitles", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    completeWithPreparedSimpleCompletionModel.mockReset();
    prepareSimpleCompletionModelForAgent.mockReset();
    resolveSimpleCompletionSelectionForAgent.mockReset();
    // Default: the agent's primary model already routes to OpenAI, so the
    // Luna fallback is permitted by the egress gate.
    resolveSimpleCompletionSelectionForAgent.mockReturnValue({
      provider: "openai",
      modelId: "gpt-5.5",
      agentDir: "/tmp/openclaw-agent",
    });
    // realpath: macOS tmpdir is a /var -> /private/var symlink and DB paths resolve canonically.
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tool-titles-")));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    closeOpenClawAgentDatabases();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("generates titles keyed by item id", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "item-1": "Checked repo status", "item-2": "Listed source files" });

    const result = await generateToolCallTitles({
      cfg: {} satisfies OpenClawConfig,
      agentId: AGENT_ID,
      items: [
        { id: "item-1", name: "bash", input: "git status --short" },
        { id: "item-2", name: "bash", input: "ls -la src" },
      ],
    });

    expect(result).toEqual({
      "item-1": "Checked repo status",
      "item-2": "Listed source files",
    });
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(1);
  });

  it("serves repeated items from the SQLite cache without a second completion", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "item-1": "Checked repo status" });
    const params = {
      cfg: {} satisfies OpenClawConfig,
      agentId: AGENT_ID,
      items: [{ id: "item-1", name: "bash", input: "git status --short" }],
    };

    const first = await generateToolCallTitles(params);
    const second = await generateToolCallTitles(params);

    expect(first).toEqual({ "item-1": "Checked repo status" });
    expect(second).toEqual(first);
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(1);
  });

  it("fails closed to an empty result when model preparation errors", async () => {
    prepareSimpleCompletionModelForAgent.mockResolvedValue({
      error: 'No API key resolved for provider "openai".',
    });

    await expect(
      generateToolCallTitles({
        cfg: {} satisfies OpenClawConfig,
        agentId: AGENT_ID,
        items: [{ id: "item-1", name: "bash", input: "git status --short" }],
      }),
    ).resolves.toEqual({});
    expect(completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("prepares the configured utility model when one is set", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "item-1": "Checked repo status" });
    const cfg = { agents: { defaults: { utilityModel: "openai/gpt-test" } } };

    await generateToolCallTitles({
      cfg,
      agentId: AGENT_ID,
      items: [{ id: "item-1", name: "bash", input: "git status --short" }],
    });

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: AGENT_ID,
      useUtilityModel: true,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("falls back to the Luna default model ref without a utility model", async () => {
    mockPreparedModel();
    mockCompletionTitles({ "item-1": "Checked repo status" });
    const cfg = {} satisfies OpenClawConfig;

    await generateToolCallTitles({
      cfg,
      agentId: AGENT_ID,
      items: [{ id: "item-1", name: "bash", input: "git status --short" }],
    });

    expect(prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: AGENT_ID,
      modelRef: "openai/gpt-5.6-luna",
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("skips the Luna default when the agent's primary provider is not OpenAI", async () => {
    resolveSimpleCompletionSelectionForAgent.mockReturnValue({
      provider: "anthropic",
      modelId: "claude-test",
      agentDir: "/tmp/openclaw-agent",
    });

    await expect(
      generateToolCallTitles({
        cfg: {} satisfies OpenClawConfig,
        agentId: AGENT_ID,
        items: [{ id: "item-1", name: "bash", input: "git status --short" }],
      }),
    ).resolves.toEqual({});
    expect(prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expect(completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });
});
