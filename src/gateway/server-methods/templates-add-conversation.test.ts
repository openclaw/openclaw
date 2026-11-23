import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TemplateInstallOutcome } from "../../shared/template-install-notice.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { completeAgentOnboarding } from "./agents-onboarding.js";
import { readChatHistoryPage } from "./chat-history-pages.js";
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
  { kind: "automation-plan", slots: [{ slotId: "morning", name: "Morning review" }] },
  {
    kind: "automation-created",
    declarationId: "morning",
    schedulerJobId: "job-morning",
    definition: {
      id: "job-morning",
      name: "Saved title",
      enabled: false,
      configRevision: "r1",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    },
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
      const block =
        outcome.kind === "automation-plan"
          ? {
              type: "automation_creation_plan",
              planId: "template:scout",
              slots: [{ slotId: "morning", name: "Morning review" }],
            }
          : {
              type: "automation_creation_result",
              planId: "template:scout",
              slotId: "morning",
              ...(outcome.kind === "automation-created"
                ? { status: "created", jobId: "job-morning", definition: outcome.definition }
                : { status: "failed" }),
            };
      const projected = {
        role: "assistant",
        provider: "openclaw",
        model: "gateway-injected",
        content: [block],
      };
      expect(messages[0]).toMatchObject({
        ...projected,
        content: [],
        openclawDisplayContent: [block],
      });
      expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ message: projected });
      const history = await readChatHistoryPage({
        entry,
        provider: undefined,
        sessionId: entry.sessionId,
        storePath: resolveSessionStorePathCore(config.session?.store, { agentId: target.agentId }),
        sessionAgentId: target.agentId,
        canonicalKey: target.sessionKey,
        max: 10,
        maxHistoryBytes: 512 * 1024,
        effectiveMaxChars: 8000,
        offset: undefined,
        messageId: undefined,
      });
      expect(history.messages).toMatchObject([projected]);
    }
    expect(JSON.stringify(messages)).not.toContain("Template setup confirmed");
  });
});
