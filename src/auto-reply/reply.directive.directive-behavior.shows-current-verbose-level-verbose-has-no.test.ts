// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { runEmbeddedAgentMock } from "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { installDirectiveBehaviorE2EHooks } from "./reply.directive.directive-behavior.e2e-harness.js";
import { handleDirectiveOnly } from "./reply/directive-handling.impl.js";
import type { HandleDirectiveOnlyParams } from "./reply/directive-handling.params.js";
import { parseInlineSessionDirectives } from "./reply/directive-handling.parse.js";

const emptyAliasIndex: ModelAliasIndex = {
  byAlias: new Map(),
  byKey: new Map(),
};

function directiveConfig(
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
): OpenClawConfig {
  return {
    commands: { text: true },
    agents: {
      defaults: { model: "anthropic/claude-opus-4-6", workspace: "/tmp/openclaw", ...defaults },
    },
  };
}

const fastConfig = () =>
  directiveConfig({
    models: {
      "anthropic/claude-opus-4-6": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
    },
  });

async function runDirectiveStatus(
  body: string,
  overrides: Partial<HandleDirectiveOnlyParams> = {},
): Promise<{ text?: string; sessionEntry: SessionEntry }> {
  const sessionKey = overrides.sessionKey ?? "agent:main:whatsapp:+1222";
  const sessionEntry = overrides.sessionEntry ?? { sessionId: "status", updatedAt: Date.now() };
  const result = await handleDirectiveOnly({
    agentId: "main",
    directives: parseInlineSessionDirectives(body),
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: emptyAliasIndex,
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    senderIsOwner: true,
    ...overrides,
    cfg: createCanonicalAgentConfigFixture(overrides.cfg ?? directiveConfig()).config,
    sessionEntry,
    sessionStore: overrides.sessionStore ?? { [sessionKey]: sessionEntry },
    sessionKey,
  });
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  return { text: result?.text, sessionEntry };
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it.each<[string, Partial<HandleDirectiveOnlyParams>, string, string]>([
    [
      "/fast",
      { cfg: fastConfig() },
      "Current fast mode: auto (30 sec) (default: model)",
      "on, off, ultrafast, auto (30 sec), default, status.",
    ],
    ["/verbose", { currentVerboseLevel: "on" }, "Current verbose level: on", "on, full, off."],
    ["/reasoning", {}, "Current reasoning level: off", "on, off, stream."],
    [
      "/elevated",
      { elevatedAllowed: true, elevatedEnabled: true, currentElevatedLevel: "on" },
      "Current elevated level: on",
      "on, off, ask, full.",
    ],
    [
      "/exec",
      {
        cfg: {
          ...directiveConfig(),
          tools: { exec: { host: "gateway", security: "allowlist", ask: "always", node: "mac-1" } },
        },
      },
      "Current exec defaults: host=gateway, effective=gateway, security=allowlist, ask=always, node=mac-1.",
      "host=auto|sandbox|gateway|node, security=deny|allowlist|full, ask=off|on-miss|always, node=<id>.",
    ],
  ])("reports current %s defaults without arguments", async (body, overrides, current, options) => {
    const { text } = await runDirectiveStatus(body, overrides);
    expect(text).toContain(current);
    expect(text).toContain(`Options: ${options}`);
  });

  it("reports concise fast status for explicit status queries", async () => {
    const { text } = await runDirectiveStatus("/fast status", { cfg: fastConfig() });
    expect(text).toContain("Current fast mode: auto (30 sec) (default: model)");
    expect(text).not.toContain("Options:");
  });

  it.each([
    ["restricted", false, "enabled"],
    ["work", true, "allowFrom.whatsapp"],
  ] as const)(
    "enforces %s agent elevated restrictions",
    async (agentId, elevatedEnabled, field) => {
      const gate = `agents.entries.*.tools.elevated.${field}`;
      const { text } = await runDirectiveStatus("/elevated on", {
        sessionKey: `agent:${agentId}:main`,
        agentId,
        elevatedEnabled,
        elevatedAllowed: false,
        elevatedFailures: [{ gate, key: `agents.entries.${agentId}.tools.elevated.${field}` }],
      });
      expect(text).toContain(gate);
    },
  );

  it("allows elevated after per-agent allowlist checks", async () => {
    const { text } = await runDirectiveStatus("/elevated on", {
      sessionKey: "agent:work:main",
      agentId: "work",
      elevatedEnabled: true,
      elevatedAllowed: true,
    });
    expect(text).toContain("Elevated mode set to ask");
  });

  it.each<[string, string[]]>([
    ["/elevated off", ["Elevated mode disabled.", "Runtime is direct; sandboxing does not apply."]],
    ["/elevated maybe", ["Unrecognized elevated level"]],
    ["/elevated off\n/verbose on", ["Elevated mode disabled.", "Verbose logging enabled."]],
  ])("handles elevated response for %s", async (body, snippets) => {
    const { text } = await runDirectiveStatus(body, {
      elevatedEnabled: true,
      elevatedAllowed: true,
    });
    snippets.forEach((snippet) => expect(text).toContain(snippet));
  });

  it("persists queue overrides and reset behavior", async () => {
    const interrupt = await runDirectiveStatus("/queue interrupt");
    expect(interrupt).toMatchObject({
      text: expect.stringMatching(/^⚙️ Queue mode set to interrupt\./),
      sessionEntry: { queueMode: "interrupt" },
    });
    const collect = await runDirectiveStatus("/queue collect debounce:2s cap:5 drop:old");
    expect(collect.text).toMatch(/^⚙️ Queue mode set to collect\./);
    expect(collect.text).toMatch(/Queue debounce set to 2000ms/);
    expect(collect.text).toMatch(/Queue cap set to 5/);
    expect(collect.text).toMatch(/Queue drop set to old/);
    expect(collect.sessionEntry).toMatchObject({
      queueMode: "collect",
      queueDebounceMs: 2000,
      queueCap: 5,
      queueDrop: "old",
    });
    const reset = await runDirectiveStatus("/queue reset", {
      sessionEntry: { ...collect.sessionEntry, sessionId: "queue" },
    });
    expect(reset.text).toMatch(/^⚙️ Queue mode reset to default\./);
    expect(reset.sessionEntry.queueMode).toBeUndefined();
    expect(reset.sessionEntry.queueDebounceMs).toBeUndefined();
    expect(reset.sessionEntry.queueCap).toBeUndefined();
    expect(reset.sessionEntry.queueDrop).toBeUndefined();
  });

  it("shows current trace level", async () => {
    const { text } = await runDirectiveStatus("/trace", {
      sessionEntry: { sessionId: "trace", updatedAt: Date.now(), traceLevel: "on" },
    });
    expect(text).toContain("Current trace level: on");
  });

  it.each([
    ["on", "Trace enabled.", true],
    ["off", "Trace disabled.", false],
    ["raw", "Trace set to raw.", true],
  ] as const)("persists trace %s with the appropriate warning", async (level, message, warning) => {
    const result = await runDirectiveStatus(
      `/trace ${level}`,
      level === "off"
        ? {
            sessionEntry: { sessionId: "trace", updatedAt: Date.now(), traceLevel: "on" },
          }
        : {},
    );
    expect(result).toMatchObject({
      text: expect.stringContaining(message),
      sessionEntry: { traceLevel: level },
    });
    expect(result.text?.includes("may contain sensitive information")).toBe(warning);
  });

  it("blocks /trace for non-owners without delegated gateway scope", async () => {
    const denied = await runDirectiveStatus("/trace raw", {
      senderIsOwner: false,
      gatewayClientScopes: ["operator.write"],
    });
    expect(denied.text).toContain("/trace is restricted to owners and gateway clients");
    expect(denied.sessionEntry.traceLevel).toBeUndefined();
  });

  it("allows /trace for delegated gateway clients with operator.admin", async () => {
    const allowed = await runDirectiveStatus("/trace on", {
      senderIsOwner: false,
      gatewayClientScopes: ["operator.admin"],
    });
    expect(allowed).toMatchObject({
      text: expect.stringContaining("Trace enabled."),
      sessionEntry: { traceLevel: "on" },
    });
    expect(allowed.text).toContain("may contain sensitive information");
  });
});
