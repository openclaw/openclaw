import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TemplateInstallOutcome } from "../../shared/template-install-notice.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { completeAgentOnboarding } from "./agents-onboarding.js";
import { publishTemplateInstallEvent } from "./templates-add-conversation.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const outcomes: TemplateInstallOutcome[] = [
  {
    kind: "plugin-install",
    plugin: {
      type: "template_plugin_install",
      pluginId: "calendar",
      packageName: "@fixture/calendar",
      displayName: "Calendar",
      status: "installed",
    },
  },
  {
    kind: "plugin-install",
    plugin: {
      type: "template_plugin_install",
      pluginId: "calendar",
      packageName: "@fixture/calendar",
      displayName: "Calendar",
      status: "error",
    },
  },
  {
    kind: "automation-created",
    declarationId: "morning",
    schedulerJobId: "job-morning",
    name: "Morning review",
    enabled: false,
  },
  { kind: "automation-failed", declarationId: "morning", name: "Morning review" },
];
it.each(outcomes)("publishes only one installer-authored outcome: $kind", async (outcome) => {
  await withOpenClawTestState({ label: "template-result-notice" }, async () => {
    const config: OpenClawConfig = { agents: { entries: { main: {}, scout: {} } } };
    setRuntimeConfigSnapshot(config);
    const broadcast = vi.fn();
    const context = { getRuntimeConfig: () => config, broadcast, nodeSendToSession: vi.fn() };
    const options = {
      req: { type: "req", id: "install", method: "templates.add.apply" },
      context,
      client: null,
      respond: vi.fn(),
    } as unknown as GatewayRequestHandlerOptions;
    const prepared = await completeAgentOnboarding(options, "scout", { config });
    expect(prepared.status).toBe("completed");
    const target = { agentId: "scout", sessionKey: prepared.sessionKey };
    const entry = loadSessionEntryReadOnly(target)!;
    const event = { ...target, ...outcome };
    let allowed = true;
    const assertCurrent = () => {
      if (!allowed) {
        throw new Error("Fixture authority revoked");
      }
    };
    await publishTemplateInstallEvent(context, event, assertCurrent);
    await publishTemplateInstallEvent(context, event, assertCurrent);
    allowed = false;
    await expect(publishTemplateInstallEvent(context, event, assertCurrent)).rejects.toThrow(
      "Fixture authority revoked",
    );
    const messages = (await loadTranscriptEvents({ ...target, sessionId: entry.sessionId }))
      .filter(isRecord)
      .filter((entryEvent) => entryEvent.type === "message")
      .map((entryEvent) => entryEvent.message);
    expect(messages).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    if (outcome.kind === "plugin-install") {
      expect(messages[0]).toMatchObject({
        role: "assistant",
        content: [],
        openclawDisplayContent: [outcome.plugin],
      });
      expect(broadcast.mock.calls[0]?.[1]).toMatchObject({
        message: { content: [outcome.plugin] },
      });
      expect(outcome.plugin).not.toHaveProperty("official");
    } else {
      expect(messages[0]).toMatchObject({
        role: "system",
        excludeFromContext: true,
        provenance: { kind: "internal_system", sourceTool: "templates_add_installer" },
        content: [
          {
            type: "text",
            text:
              outcome.kind === "automation-created"
                ? "Automation created: Morning review (paused until setup is ready)."
                : "Automation setup failed: Morning review. Continue setup in this agent.",
          },
        ],
      });
    }
    expect(JSON.stringify(messages)).not.toContain("Template setup confirmed");
  });
});
