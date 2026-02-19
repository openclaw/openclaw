import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceEdgee } from "./auth-choice.apply.edgee.js";

const noopAsync = async () => {};
const noop = () => {};
const authProfilePathFor = (agentDir: string) => path.join(agentDir, "auth-profiles.json");

describe("applyAuthChoiceEdgee", () => {
  let tempStateDir: string | null = null;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousEdgeeKey = process.env.EDGEE_API_KEY;

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (previousEdgeeKey === undefined) {
      delete process.env.EDGEE_API_KEY;
    } else {
      process.env.EDGEE_API_KEY = previousEdgeeKey;
    }
  });

  it("prompts for key and writes auth profile + default model", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edgee-"));
    const agentDir = path.join(tempStateDir, "agent");
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    await fs.mkdir(agentDir, { recursive: true });

    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select: vi.fn(async (params) => params.options?.[0]?.value as never),
      multiselect: vi.fn(async () => []),
      text: vi.fn().mockResolvedValue("edgee-key-123"),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: noop, stop: noop })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await applyAuthChoiceEdgee({
      authChoice: "edgee-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      agentDir,
    });

    expect(result.config.auth?.profiles?.["edgee:default"]).toMatchObject({
      provider: "edgee",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("edgee/openai/gpt-4o");

    const raw = await fs.readFile(authProfilePathFor(agentDir), "utf8");
    const parsed = JSON.parse(raw) as { profiles?: Record<string, { key?: string }> };
    expect(parsed.profiles?.["edgee:default"]?.key).toBe("edgee-key-123");
  });

  it("uses opts token for edgee without prompting for text input", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edgee-"));
    const agentDir = path.join(tempStateDir, "agent");
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    await fs.mkdir(agentDir, { recursive: true });

    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => true);
    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select: vi.fn(async (params) => params.options?.[0]?.value as never),
      multiselect: vi.fn(async () => []),
      text,
      confirm,
      progress: vi.fn(() => ({ update: noop, stop: noop })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await applyAuthChoiceEdgee({
      authChoice: "edgee-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
      agentDir,
      opts: {
        tokenProvider: "edgee",
        token: "edgee-opts-token",
      },
    });

    expect(result.agentModelOverride).toBe("edgee/openai/gpt-4o");
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    const raw = await fs.readFile(authProfilePathFor(agentDir), "utf8");
    const parsed = JSON.parse(raw) as { profiles?: Record<string, { key?: string }> };
    expect(parsed.profiles?.["edgee:default"]?.key).toBe("edgee-opts-token");
  });
});
