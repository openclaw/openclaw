import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { loadSessionStore } from "../config/sessions.js";

export { loadModelCatalog } from "../agents/model-catalog.js";
export { runEmbeddedPiAgent } from "../agents/pi-embedded.js";

export const MAIN_SESSION_KEY = "agent:main:main";

export const DEFAULT_TEST_MODEL_CATALOG: Array<{
  id: string;
  name: string;
  provider: string;
}> = [
  { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-1", name: "Sonnet 4.1", provider: "anthropic" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
];

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      return await fn(home);
    },
    {
      env: {
        OPENCLAW_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
        PI_CODING_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
      },
      prefix: "openclaw-reply-",
    },
  );
}

export function assertModelSelection(
  storePath: string,
  selection: { model?: string; provider?: string } = {},
) {
  const store = loadSessionStore(storePath);
  const entry = store[MAIN_SESSION_KEY];
  expect(entry).toBeDefined();
  expect(entry?.modelOverride).toBe(selection.model);
  expect(entry?.providerOverride).toBe(selection.provider);
}

export function installDirectiveBehaviorE2EHooks() {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue(DEFAULT_TEST_MODEL_CATALOG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}
