import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";

export const noopAsync = async () => {};
export const noop = () => {};

export function createExitThrowingRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

export function createWizardPrompter(
  overrides: Partial<WizardPrompter>,
  options?: { defaultSelect?: string },
): WizardPrompter {
  return {
    intro: vi.fn(noopAsync),
    outro: vi.fn(noopAsync),
    note: vi.fn(noopAsync),
    select: vi.fn(async () => (options?.defaultSelect ?? "") as never),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as unknown as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: noop, stop: noop })),
    ...overrides,
  };
}

export async function setupAuthTestEnv(
  prefix = "openclaw-auth-",
  options?: { agentSubdir?: string },
): Promise<{
  stateDir: string;
  agentDir: string;
}> {
  const stateDir = await makeTempWorkspace(prefix);
  const agentDir = path.join(stateDir, options?.agentSubdir ?? "agent");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await fs.mkdir(agentDir, { recursive: true });
  return { stateDir, agentDir };
}

export async function readAuthProfilesForAgent<T>(agentDir: string): Promise<T> {
  const raw = await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8");
  return JSON.parse(raw) as T;
}
