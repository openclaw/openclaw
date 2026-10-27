import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { resolveCurrentSessionAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import {
  completionConfig,
  completionModelDefinition,
} from "../agents/simple-completion.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const session = {
  agentId: "main",
  provider: "openai",
  model: "gpt-5.6-luna",
  sessionKey: "agent:main:main",
};
const configuredModels: OpenClawConfig = {
  agents: { defaults: { models: { "openai/gpt-5.6-luna": {} } } },
};
type Params = Parameters<typeof resolveCurrentSessionAgentRuntimeMetadata>[0];
const resolve = (overrides: Partial<Omit<Params, "agentId" | "agentScope">>) =>
  resolveCurrentSessionAgentRuntimeMetadata({ ...session, cfg: configuredModels, ...overrides });

const registeredHarnesses = listRegisteredAgentHarnesses();
beforeEach(() => clearAgentHarnesses());
afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

it("projects a declared fallback for the next turn while retaining session-key attribution", () => {
  const supports = vi.fn((_context: unknown) => ({
    supported: false as const,
    fallbackRuntime: "openclaw" as const,
  }));
  registerAgentHarness({
    id: "codex",
    label: "Codex",
    supports,
    runAttempt: async () => {
      throw new Error("projection must not execute");
    },
  });
  const model = completionModelDefinition({
    id: "gpt-5.6-luna",
    compat: { supportsStore: false },
  });
  const provider: Parameters<typeof completionConfig>[1] = {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    models: [model],
  };
  const cfg = completionConfig("openai", provider, configuredModels);
  const params = {
    cfg,
    sessionEntry: {
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
    },
  };
  expect(resolve(params)).toEqual({ id: "openclaw", source: "session-key" });
  expect(
    resolve({
      ...params,
      sessionEntry: { ...params.sessionEntry, modelSelectionLocked: true },
    }),
  ).toEqual({ id: "codex", source: "session" });
  expect(
    resolve({
      ...params,
      sessionKey: "agent:main:acp:runtime-test",
      acpRuntime: true,
    }),
  ).toEqual({ id: "acpx", source: "session-key" });
  // Projection consumes registered support only; it never discovers provider ownership.
  for (const [context] of supports.mock.calls) {
    expect(context).not.toHaveProperty("providerOwnerStatus");
  }
});

it.each([
  ["implicit", configuredModels, { agentHarnessId: "openclaw" }],
  [
    "session-key",
    { agents: { entries: { copilot: {}, main: {} }, defaults: {} } },
    { agentHarnessId: "openclaw", agentRuntimeOverride: "codex" },
  ],
] as const)(
  "reports %s policy instead of an unlocked historical producer",
  (source, cfg, sessionEntry) => {
    expect(resolve({ cfg, sessionEntry })).toEqual({ id: "codex", source });
  },
);
