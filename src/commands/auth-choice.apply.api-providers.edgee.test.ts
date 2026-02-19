import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceApiProviders } from "./auth-choice.apply.api-providers.js";

const noopAsync = async () => {};
const noop = () => {};

describe("applyAuthChoiceApiProviders edgee routing", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("routes apiKey + tokenProvider=edgee to edgee handler", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edgee-"));

    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select: vi.fn(async (params) => params.options?.[0]?.value as never),
      multiselect: vi.fn(async () => []),
      text: vi.fn(async () => "unused"),
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

    const result = await applyAuthChoiceApiProviders({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
      agentDir: tempDir,
      opts: {
        tokenProvider: "edgee",
        token: "edgee-token-provider",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["edgee:default"]?.provider).toBe("edgee");
    expect(result?.agentModelOverride).toBe("edgee/openai/gpt-4o");
  });
});
