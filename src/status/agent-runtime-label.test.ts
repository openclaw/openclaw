import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import { expect, it } from "vitest";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";

type Args = Parameters<typeof resolveAgentRuntimeLabel>[0];
const classifyCliProvider = (id: string) => ["claude-cli", "google-gemini-cli"].includes(id);
const acp = (backend: string): SessionAcpMeta => ({
  agent: "gemini",
  backend,
  runtimeSessionName: "gemini-session",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 0,
});
const session = (
  sessionEntry: Args["sessionEntry"],
  rest: Omit<Args, "sessionEntry"> = {},
): Args => ({ sessionEntry, ...rest });
const pin = (agentHarnessId: string, resolvedHarness = "codex", patch: Args["sessionEntry"] = {}) =>
  session({ agentHarnessId, ...patch }, { resolvedHarness });

it.each<[Args, string]>([
  [
    session({ acp: acp("acpx"), agentHarnessId: "codex" }, { resolvedHarness: "openclaw" }),
    "gemini (acp/acpx)",
  ],
  [session({ acp: acp("") }), "gemini (acp)"],
  [session({ modelProvider: "claude-cli" }, { resolvedHarness: "auto" }), "Claude CLI"],
  [{ resolvedHarness: "default", fallbackProvider: "google-gemini-cli" }, "Gemini CLI"],
  [{ fallbackProvider: "vendor-cli", classifyCliProvider: () => true }, "vendor-cli (cli)"],
  [
    {
      ...pin("codex", "claude-bridge", { modelProvider: "anthropic", modelSelectionLocked: true }),
      fallbackProvider: "anthropic",
      classifyCliProvider: () => false,
    },
    "claude-bridge (session pin: OpenAI Codex)",
  ],
  [pin("codex"), "OpenAI Codex"],
  [pin("codex-app-server"), "OpenAI Codex"],
  [pin("codex-cli", "codex", { modelSelectionLocked: true }), "OpenAI Codex"],
  [
    pin("openclaw", "codex", { modelSelectionLocked: true, pluginOwnerId: "model-owner" }),
    "OpenAI Codex (previous runtime: OpenClaw Default)",
  ],
  [pin("codex-cli", "claude-cli"), "Claude CLI (previous runtime: OpenAI Codex)"],
  [pin("auto"), "OpenAI Codex"],
  [
    session({ agentHarnessId: "codex", modelProvider: "claude-cli" }),
    "Claude CLI (previous runtime: OpenAI Codex)",
  ],
  [
    session(
      { agentHarnessId: "codex" },
      { fallbackProvider: "anthropic", classifyCliProvider: () => false },
    ),
    "OpenClaw Default (previous runtime: OpenAI Codex)",
  ],
  [pin("custom-harness"), "OpenAI Codex (previous runtime: custom-harness)"],
])("labels %j as %s", (args, expected) => {
  expect(resolveAgentRuntimeLabel({ classifyCliProvider, ...args })).toBe(expected);
});
