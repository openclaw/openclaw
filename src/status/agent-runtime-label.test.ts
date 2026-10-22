import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import { describe, expect, it } from "vitest";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";

type LabelArgs = Parameters<typeof resolveAgentRuntimeLabel>[0];

const classifyCliProvider = (provider: string) =>
  provider === "claude-cli" || provider === "google-gemini-cli";

const acpMeta = (agent: string, backend: string): SessionAcpMeta => ({
  agent,
  backend,
  runtimeSessionName: `${agent}-session`,
  mode: "persistent",
  state: "idle",
  lastActivityAt: 0,
});

const recordedRuntime = (
  agentHarnessId: string,
  resolvedHarness = "codex",
  session: LabelArgs["sessionEntry"] = {},
): LabelArgs => ({ sessionEntry: { agentHarnessId, ...session }, resolvedHarness });

describe("resolveAgentRuntimeLabel", () => {
  it.each<[string, LabelArgs, string]>([
    [
      "ACP agent and backend outrank the resolved harness",
      {
        sessionEntry: { acp: acpMeta("gemini", "acpx"), agentHarnessId: "codex" },
        resolvedHarness: "openclaw",
      },
      "gemini (acp/acpx)",
    ],
    ["ACP without backend", { sessionEntry: { acp: acpMeta("gemini", "") } }, "gemini (acp)"],
    [
      "auto uses session CLI provider",
      { sessionEntry: { modelProvider: "claude-cli" }, resolvedHarness: "auto" },
      "Claude CLI",
    ],
    [
      "default uses fallback CLI provider",
      { resolvedHarness: "default", fallbackProvider: "google-gemini-cli" },
      "Gemini CLI",
    ],
    [
      "unmapped CLI provider",
      { fallbackProvider: "vendor-cli", classifyCliProvider: () => true },
      "vendor-cli (cli)",
    ],
    [
      "locked pin differs from resolved harness",
      {
        ...recordedRuntime("codex", "claude-bridge", {
          modelProvider: "anthropic",
          modelSelectionLocked: true,
        }),
        fallbackProvider: "anthropic",
        classifyCliProvider: () => false,
      },
      "claude-bridge (session pin: OpenAI Codex)",
    ],
    ["matching pin adds no note", recordedRuntime("codex"), "OpenAI Codex"],
    ["retired pin alias matches", recordedRuntime("codex-app-server"), "OpenAI Codex"],
    [
      "locked retired pin alias matches",
      recordedRuntime("codex-cli", "codex", { modelSelectionLocked: true }),
      "OpenAI Codex",
    ],
    [
      "plugin-owned locked harness is history",
      recordedRuntime("openclaw", "codex", {
        modelSelectionLocked: true,
        pluginOwnerId: "model-owner",
      }),
      "OpenAI Codex (previous runtime: OpenClaw Default)",
    ],
    [
      "retired pin still reports transition",
      recordedRuntime("codex-cli", "claude-cli"),
      "Claude CLI (previous runtime: OpenAI Codex)",
    ],
    ["auto pin has no ownership", recordedRuntime("auto"), "OpenAI Codex"],
    [
      "pin differs from CLI provider fallback",
      { sessionEntry: { agentHarnessId: "codex", modelProvider: "claude-cli" } },
      "Claude CLI (previous runtime: OpenAI Codex)",
    ],
    [
      "pin differs from built-in fallback",
      {
        sessionEntry: { agentHarnessId: "codex" },
        fallbackProvider: "anthropic",
        classifyCliProvider: () => false,
      },
      "OpenClaw Default (previous runtime: OpenAI Codex)",
    ],
    [
      "unmapped pin uses sanitized id",
      recordedRuntime("custom-harness"),
      "OpenAI Codex (previous runtime: custom-harness)",
    ],
  ])("%s", (_name, args, expected) => {
    expect(resolveAgentRuntimeLabel({ classifyCliProvider, ...args })).toBe(expected);
  });
});
