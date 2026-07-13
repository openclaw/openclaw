import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import type { VerboseLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildStatusText, resolveStatusChannelFeatureLine } from "./status-text.js";
import type { BuildStatusTextParams } from "./status-text.types.js";

describe("buildStatusText channel features", () => {
  it.each([
    { richMessages: undefined, expected: "Telegram rich messages: off" },
    { richMessages: false, expected: "Telegram rich messages: off" },
    { richMessages: true, expected: "Telegram rich messages: on" },
  ])("shows Telegram rich message state for %s", ({ richMessages, expected }) => {
    const telegram = richMessages === undefined ? {} : { richMessages };
    const text = resolveStatusChannelFeatureLine({
      cfg: { channels: { telegram } },
      sessionEntry: { sessionId: `telegram-rich-${String(richMessages)}`, updatedAt: 0 },
      statusChannel: "telegram",
    });

    expect(text).toContain(expected);
    if (richMessages === true) {
      expect(text).toContain("sendRichMessage enabled");
    } else {
      expect(text).toContain("channels.telegram.richMessages=true");
    }
  });

  it("uses Telegram account rich message overrides", () => {
    const text = resolveStatusChannelFeatureLine({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            accounts: { Work: { richMessages: false } },
          },
        },
      },
      sessionEntry: {
        sessionId: "telegram-rich-account",
        updatedAt: 0,
        lastAccountId: "work",
      },
      statusChannel: "telegram",
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });

  it("uses the current Telegram command account before the session records it", () => {
    const text = resolveStatusChannelFeatureLine({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            accounts: { Work: { richMessages: false } },
          },
        },
      },
      sessionEntry: {
        sessionId: "telegram-rich-command-account",
        updatedAt: 0,
      },
      statusChannel: "telegram",
      statusAccountId: "work",
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });
});

describe("buildStatusText subagent done-only summary verbose gate", () => {
  // Drives the real verbose→subagent-line mapping in buildStatusText. The
  // completed-count ("0 active · N done") line is tool-summary-class status:
  // "commentary" is narration-only and must suppress it, while off/on/full stay
  // unchanged. This mirrors the sibling /status plugin-status gate test.
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  // Seed a DONE-ONLY run (endedAt set, outcome ok, no descendants) owned by the
  // orchestrator session key so listControlledSubagentRuns("agent:main:main")
  // surfaces exactly one completed run and zero active.
  function seedDoneOnlyRun(): void {
    addSubagentRunForTests({
      runId: "run-status-text-done-only",
      childSessionKey: "agent:main:subagent:status-text-done-only",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finished status-text task",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
      endedAt: 2000,
      outcome: { status: "ok" },
    });
  }

  function buildParams(resolvedVerboseLevel: VerboseLevel): BuildStatusTextParams {
    return {
      cfg: {
        commands: { text: true },
        session: { mainKey: "main", scope: "per-sender" },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      statusChannel: "whatsapp",
      workspaceDir: "/tmp",
      provider: "anthropic",
      model: "claude-opus-4-6",
      contextTokens: 0,
      resolvedFastMode: false,
      resolvedVerboseLevel,
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      // Overrides keep the render side-effect-free: skip harness selection, auth
      // label lookups, plugin-health collection, and task-registry probes so the
      // test exercises only the verbose→subagent-line gate.
      resolvedHarness: "openclaw",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
      pluginHealthLineOverride: "🔌 Plugins: test",
      skipDefaultTaskLookup: true,
    };
  }

  it("suppresses the completed-count line under commentary and renders it under on/full", async () => {
    seedDoneOnlyRun();

    const commentary = await buildStatusText(buildParams("commentary"));
    // commentary = narration-only: the done-only summary is a tool-summary lane
    // line and must not appear.
    expect(commentary).not.toContain("🤖 Subagents:");
    expect(commentary).not.toContain("0 active");

    const on = await buildStatusText(buildParams("on"));
    expect(on).toContain("🤖 Subagents: 0 active · 1 done");

    const full = await buildStatusText(buildParams("full"));
    expect(full).toContain("🤖 Subagents: 0 active · 1 done");
  });
});
