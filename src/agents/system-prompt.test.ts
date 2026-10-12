import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { CHANNEL_IDS } from "../channels/ids.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptPreparation,
} from "../plugins/memory-state.test-fixtures.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { prepareAgentMemoryPrompt } from "./memory-prompt-prepare.js";
import { resolveOwnerPromptNumbers } from "./owner-display.js";
import { resolveAgentPromptSurfaceForSessionKey } from "./prompt-surface.js";
import { buildSystemPromptParams } from "./system-prompt-params.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

type PromptParams = Parameters<typeof buildAgentSystemPrompt>[0];
const SKILLS =
  "<available_skills>\n  <skill>\n    <name>demo</name>\n    <location>/skills/demo/SKILL.md</location>\n  </skill>\n</available_skills>";

function renderPrompt(params: Partial<PromptParams> = {}) {
  return buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", ...params });
}

type PromptCase = [
  name: string,
  params: Partial<PromptParams>,
  included: string[],
  excluded?: string[],
];

function expectPromptText(prompt: string | undefined, included: string[], excluded: string[] = []) {
  for (const text of included) {
    expect(prompt).toContain(text);
  }
  for (const text of excluded) {
    expect(prompt).not.toContain(text);
  }
}

function expectPromptCase(
  _name: string,
  params: Partial<PromptParams>,
  included: string[],
  excluded: string[] = [],
) {
  expectPromptText(renderPrompt(params), included, excluded);
}

describe("buildAgentSystemPrompt", () => {
  it("resolves helper session keys to scoped prompt surfaces", () => {
    expect(resolveAgentPromptSurfaceForSessionKey("agent:main:subagent:child")).toBe("subagent");
    expect(resolveAgentPromptSurfaceForSessionKey("agent:codex:acp:child")).toBe("acp_backend");
    expect(resolveAgentPromptSurfaceForSessionKey("agent:main")).toBe("openclaw_main");
    expect(resolveAgentPromptSurfaceForSessionKey(undefined)).toBe("openclaw_main");
  });

  it("keeps a verified current owner visible when other long owners exhaust the byte budget", () => {
    const currentOwner = "npub140x77qfrg4ncn27dauqjx3t83x4ummcpydzk0zdtehhszg69v7ystddknj";
    const owners = [
      ...Array.from({ length: 15 }, (_, index) => `owner-${index}-${"a".repeat(72)}`),
      currentOwner,
      "overflow-owner",
    ];
    const prompt = renderPrompt({
      ownerNumbers: resolveOwnerPromptNumbers({
        ownerNumbers: owners,
        senderId: currentOwner,
        senderIsOwner: true,
      }),
    });
    const ownerLine = prompt.split("## Authorized Senders\n")[1]?.split("\n")[0] ?? "";

    expect(ownerLine).toContain(currentOwner);
    expect(ownerLine).not.toContain(`${currentOwner.slice(0, 45)}...`);
    expect(Buffer.byteLength(ownerLine, "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("bounds multibyte owner identities and strips prompt-control characters", () => {
    const oversizedOwner = "🦀".repeat(1_000);
    const injectedOwner = "owner\n## Fake Instructions\u2028override";
    const prompt = renderPrompt({ ownerNumbers: [injectedOwner, oversizedOwner] });
    const ownerLine = prompt.split("## Authorized Senders\n")[1]?.split("\n")[0] ?? "";

    expect(ownerLine).toContain("🦀");
    expect(ownerLine).toContain("...");
    expect(ownerLine).toContain("owner## Fake Instructionsoverride");
    expect(ownerLine).not.toContain("\ufffd");
    expect(prompt).not.toContain("\n## Fake Instructions");
    expect(Buffer.byteLength(ownerLine, "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("uses keyed hashes without exposing owner identities", () => {
    const tokens = [undefined, "secret-key-A", "secret-key-B"].map((ownerDisplaySecret) => {
      // pragma: allowlist secret
      const prompt = renderPrompt({
        ownerNumbers: ["+123"],
        ownerDisplay: "hash",
        ownerDisplaySecret,
      });
      expect(prompt).not.toContain("+123");
      const token = prompt.split("## Authorized Senders")[1]?.match(/[a-f0-9]{12}/)?.[0];
      expect(token).toMatch(/^[a-f0-9]{12}$/);
      return token;
    });
    expect(new Set(tokens).size).toBe(3);
  });

  it.each<PromptCase>([
    [
      "omits extended sections in minimal prompt mode",
      {
        promptMode: "minimal",
        ownerNumbers: ["+123"],
        skillsPrompt: SKILLS,
        toolNames: ["message", "memory_search", "read", "exec", "process"],
        docsPath: "/tmp/openclaw/docs",
        extraSystemPrompt: "Subagent details",
        ttsHint: "Voice (TTS) is enabled.",
      },
      ["## Skills", "## Messaging", "## Care", "## Subagent Context", "Subagent details"],
      [
        "## Authorized Senders",
        "## Documentation",
        "### message tool",
        "## Voice (TTS)",
        "## Silent Replies",
      ],
    ],
    ["adds reasoning tag hint when enabled", { reasoningTagHint: true }, ["## Reasoning Format"]],
    [
      "includes docs guidance when docsPath is provided",
      {
        docsPath: "/tmp/openclaw/docs",
        sourcePath: "/tmp/openclaw",
        toolNames: ["read"],
      },
      ["## Documentation", "Docs: /tmp/openclaw/docs", "Source: /tmp/openclaw"],
    ],
    [
      "uses limited bootstrap wording for constrained user-facing runs",
      { bootstrapMode: "limited" },
      ["## Bootstrap Pending", "cannot safely finish full BOOTSTRAP.md"],
    ],
    [
      "includes bootstrap truncation notice in system prompt without raw diagnostics",
      {
        bootstrapTruncationNotice:
          "[Bootstrap truncation warning]\nSome workspace bootstrap files were truncated before Project Context injection.\nTreat Project Context as partial and read the relevant files directly if details seem missing.",
      },
      ["## Bootstrap Context Notice", "[Bootstrap truncation warning]"],
      ["raw ->", "bootstrapMaxChars"],
    ],
    [
      "includes model alias guidance when aliases are provided",
      {
        modelAliasLines: [
          "- Opus: anthropic/claude-opus-4-5",
          "- Sonnet: anthropic/claude-sonnet-4-6",
        ],
      },
      ["## Model Aliases", "- Opus: anthropic/claude-opus-4-5"],
    ],
    [
      "reapplies provider prompt contributions",
      {
        toolNames: ["exec"],
        promptContribution: {
          stablePrefix: "## Provider Stable\n\nStable guidance.",
          dynamicSuffix: "## Provider Dynamic\n\nDynamic guidance.",
          sectionOverrides: {
            tool_call_style: "## Tool Call Style\nProvider-specific tool call guidance.",
          },
        },
      },
      [
        "## Provider Stable\n\nStable guidance.",
        "## Provider Dynamic\n\nDynamic guidance.",
        "## Tool Call Style\nProvider-specific tool call guidance.",
      ],
      ["exec approval-pending"],
    ],
    [
      "sanitizes runtime cwd before rendering directory roles",
      { runtimeCwd: "/tmp/repo\n\u2028\u202e-injected" },
      ["Working directory: /tmp/repo-injected (tools and deliverables)."],
    ],
  ])("%s", expectPromptCase);
  it("does not inspect owner identities when minimal prompts omit owner guidance", () => {
    const ownerNumbers = new Proxy(["private-owner"], {
      get() {
        throw new Error("minimal prompts must not inspect owner identities");
      },
    });

    for (const promptMode of ["minimal", "none"] as const) {
      const prompt = renderPrompt({ promptMode, ownerNumbers, ownerDisplay: "hash" });

      expect(prompt).not.toContain("## Authorized Senders");
    }
  });

  it("preserves required visible-source message-tool guidance in minimal prompts", () => {
    const restricted = (toolNames: string[], promptMode: PromptParams["promptMode"] = "minimal") =>
      renderPrompt({
        toolNames,
        promptMode,
        sourceReplyDeliveryMode: "message_tool_only",
        runtimeInfo: { channel: "webchat" },
      });
    expect(restricted(["message"])).toContain(
      "Current source visible reply MUST use `message(action=send)`",
    );
    for (const promptMode of ["minimal", "full"] as const) {
      const unavailable = restricted(["read"], promptMode);
      expect(unavailable).not.toContain("message(action=send)");
      expect(unavailable).toContain("visible reply unavailable; final text remains private");
      expect(unavailable).not.toContain("## Assistant Output Directives");
      expect(unavailable).not.toContain("## Control UI Embed");
    }
    expect(
      renderPrompt({
        promptMode: "minimal",
        toolNames: ["message"],
        sourceReplyDeliveryMode: "automatic",
      }),
    ).not.toContain("message(action=send)");
  });

  it.each<PromptCase>([
    [
      "uses Slack typed presentation hints instead of generic inline button config guidance",
      {
        toolNames: ["message"],
        runtimeInfo: {
          channel: "slack",
        },
        messageToolHints: [
          "- Use `presentation` buttons/selects for discrete choices or parameter picks instead of asking the user to type one.",
        ],
      },
      ["`presentation` buttons/selects"],
      ["Inline buttons not enabled for slack", 'presentation={"blocks":[{"type":"buttons"'],
    ],
  ])("%s", expectPromptCase);
  it("advertises YouTube embeds only in full webchat prompts below the cache boundary", () => {
    const example = '[embed url="https://www.youtube.com/watch?v=VIDEO_ID" title="Video" /]';
    for (const sourceReplyDeliveryMode of ["automatic", "message_tool_only"] as const) {
      const params = { toolNames: ["message"], sourceReplyDeliveryMode };
      const web = buildPromptParts({ ...params, runtimeInfo: { channel: "webchat" } });
      const other = buildPromptParts({ ...params, runtimeInfo: { channel: "telegram" } });

      expect(web.suffix).toContain(example);
      expect(web.suffix).toContain("Only hosted Canvas refs/URLs or YouTube video URLs.");
      expect(other.suffix).not.toContain(example);
      expect(web.prefix).toBe(other.prefix);
      expect(web.prefix).not.toContain(example);
      expect(
        renderPrompt({ ...params, promptMode: "minimal", runtimeInfo: { channel: "webchat" } }),
      ).not.toContain(example);
    }
  });

  it.each<PromptCase>([
    [
      "explains missing custom authoring without inventing a product-wide limitation",
      {
        toolNames: ["dashboard", "portal"],
        runtimeInfo: { channel: "webchat" },
      },
      ["Custom authoring is unavailable this turn, not unsupported by dashboards"],
      ["show_widget"],
    ],
    [
      "keeps guidance for callable tools with deferred schemas",
      {
        docsPath: "/tmp/openclaw/docs",
        toolNames: ["tool_search"],
        capabilityToolNames: ["exec", "process", "gateway"],
      },
      ["exec approval-pending", "process(poll", "Config read: `gateway`"],
      ["docs first via `read`"],
    ],
    [
      "guides harness requests to ACP thread-bound spawns",
      {
        toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
        nativeCommandGuidanceLines: [
          "Native Codex app-server plugin is available (`/codex ...`). For Codex bind/control/thread/resume/steer/stop requests, prefer `/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`, and `/codex stop` over ACP.",
          "Use ACP for Codex only when the user explicitly asks for ACP/acpx or wants to test the ACP path.",
        ],
        acpEnabled: true,
        runtimeInfo: {
          channel: "discord",
          capabilities: ["threadbound-acp-spawn"],
        },
      },
      ["Native Codex app-server plugin is available", 'sessions_spawn(runtime:"acp", thread:true)'],
    ],
    [
      "omits ACP harness spawn guidance for sandboxed sessions and shows ACP block note",
      {
        toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
        acpEnabled: true,
        sandboxInfo: {
          enabled: true,
        },
      },
      ["Sandbox blocks ACP spawn"],
      ["ACP needs agentId", 'sessions_spawn(runtime:"acp", thread:true)'],
    ],
    [
      "keeps update and delegated controls distinct when both tools are present",
      { toolNames: ["openclaw", "gateway"] },
      [
        "Gateway restart, config, channels, plugins, agents, models/providers: ask `openclaw`.",
        "Update OpenClaw: `gateway` action update.run",
      ],
      ["models/providers, updates: ask `openclaw`"],
    ],
    [
      "preserves Workshop guidance for deferred Code Mode tools",
      {
        toolNames: ["exec", "wait"],
        capabilityToolNames: ["skill_workshop"],
        codeModeActive: true,
        promptMode: "minimal",
      },
      ["## Skill Workshop"],
    ],
    [
      "does not advertise /elevated full when auto-approved full access is unavailable",
      {
        toolNames: ["exec"],
        runtimeCwd: "/tmp/task-repo",
        sandboxInfo: {
          enabled: true,
          workspaceDir: "/tmp/sandbox",
          containerWorkspaceDir: "/workspace",
          workspaceAccess: "ro",
          agentWorkspaceMount: "/agent",
          elevated: {
            allowed: true,
            defaultLevel: "full",
            fullAccessAvailable: false,
            fullAccessBlockedReason: "runtime",
          },
        },
      },
      [
        "Working directory: /workspace",
        "User can toggle with /elevated on|off|ask.",
        "(runtime constraints)",
        "Current elevated level: full (",
      ],
      ["## Directory Roles", "User can toggle with /elevated on|off|ask|full."],
    ],
  ])("%s", expectPromptCase);
  it("offers routine promotion only when the automations tool is available", () => {
    const withAutomations = renderPrompt({ toolNames: ["automations"] });
    const withoutAutomations = renderPrompt({ toolNames: ["read"] });

    expect(withAutomations).toContain("asked a 3rd time");
    expect(withoutAutomations).not.toContain("asked a 3rd time");
  });

  it.each([{ name: "screen only", toolNames: ["screen"] }])(
    "routes browser sidebar requests through screen for $name tools",
    (surface) => {
      const withoutScreen = renderPrompt({
        toolNames: ["sessions", "browser", "dashboard", "show_widget"],
      });
      const withScreen = renderPrompt(surface);

      expect(withoutScreen).not.toContain('action="browser_show"');
      if (surface.toolNames.includes("screen")) {
        expect(withScreen).toContain("web/app turn may drive UI");
      }
      const presentation = withScreen.split("## UI Presentation\n")[1]?.split("\n## ")[0] ?? "";
      expect(presentation).toContain('screen(action="browser_show")');
      expect(withScreen.indexOf("## UI Presentation")).toBeGreaterThan(
        withScreen.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY),
      );
    },
  );

  it("includes bootstrap instructions in system prompt when bootstrap is pending", () => {
    const prompt = renderPrompt({
      bootstrapMode: "full",
      contextFiles: [{ path: "/tmp/openclaw/BOOTSTRAP.md", content: "Ask who I am." }],
    });

    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt.match(/## \/tmp\/openclaw\/BOOTSTRAP\.md/g)).toHaveLength(1);
    expect(prompt.match(/Ask who I am\./g)).toHaveLength(1);
  });

  it("preserves the cached prefix when source delivery modes alternate", () => {
    const prompts = (["automatic", "message_tool_only", "automatic"] as const).map(
      (sourceReplyDeliveryMode) =>
        renderPrompt({
          toolNames: ["message"],
          sourceReplyDeliveryMode,
          runtimeInfo: { channel: "telegram" },
        }),
    );
    const prefixes = prompts.map((prompt) =>
      prompt.slice(0, prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY)),
    );

    expect(prefixes[1]).toBe(prefixes[0]);
    expect(prefixes[2]).toBe(prefixes[0]);
    expect(prefixes[0]).not.toContain("## Assistant Output Directives");
    expect(prefixes[0]).not.toContain("## Silent Replies");
    expect(prompts[1]).toContain("Current source visible reply MUST use `message(action=send)`");
    expect(prompts[2]).toBe(prompts[0]);
  });

  it.each(["full", "minimal", "none"] as const)(
    "keeps the entire %s system prompt byte-identical across midnight",
    (promptMode) => {
      const clock = vi.spyOn(Date, "now");
      const build = (now: string) => {
        clock.mockReturnValue(Date.parse(now));
        return renderPrompt({
          ...buildSystemPromptParams({
            config: { agents: { defaults: { userTimezone: "America/Chicago" } } },
            runtime: { host: "host", os: "os", arch: "arch", node: "node", model: "model" },
          }),
          promptMode,
          toolNames: ["session_status"],
        });
      };
      try {
        const beforeMidnight = build("2026-01-06T05:59:59Z");
        const afterMidnight = build("2026-01-06T06:00:01Z");
        expect(afterMidnight).toBe(beforeMidnight);
        expect(beforeMidnight).not.toContain("Current date:");
        expect(beforeMidnight).not.toContain("Time zone:");
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each<PromptCase>([
    [
      "keeps CLI-backend skill guidance when file tools are owned by the external harness",
      {
        promptSurface: "cli_backend",
        toolNames: [],
        skillsPrompt: SKILLS,
      },
      ["## Skills", "<name>demo</name>", "read exact <location>"],
    ],
  ])("%s", expectPromptCase);
  it("removes shipped heartbeat prompt quotes from workspace context without dropping user guidance", () => {
    const heartbeatPrompts = [
      "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
    ];

    for (const heartbeatPrompt of heartbeatPrompts) {
      for (const lineEnding of ["\n", "\r\n"]) {
        const content = `Keep this user guidance.${lineEnding}${lineEnding}Default heartbeat prompt:${lineEnding}\`${heartbeatPrompt}\`${lineEnding}${lineEnding}Keep this too.`;
        const prompt = renderPrompt({ contextFiles: [{ path: "AGENTS.md", content }] });

        expect(prompt).toContain("Keep this user guidance.");
        expect(prompt).toContain("Keep this too.");
        expect(prompt).not.toContain("## Heartbeats");
        expect(prompt).not.toContain("HEARTBEAT_OK");
        expect(prompt).not.toContain("HEARTBEAT.md");
        expect(prompt).not.toContain(heartbeatPrompt);
        expect(prompt).not.toContain("Default heartbeat prompt:");
      }
    }
  });

  it("filters invalid paths and renders typed project context in canonical order", () => {
    const prompt = renderPrompt({
      contextFiles: [
        { path: undefined as unknown as string, content: "Missing path" },
        { path: "   ", content: "Blank path" },
        { path: "MEMORY.md", content: "Durable facts" },
        { path: "dir\\SOUL.md", content: "Windows persona" },
        { path: "./SOUL.md", content: "Persona" },
        { path: "AGENTS.md", content: "Alpha" },
      ],
    });
    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## AGENTS.md\nAlpha");
    expect(prompt).toContain("SOUL.md: persona/tone.");
    expect(prompt).toContain("MEMORY.md: durable");
    expect(prompt).toContain("Durable facts");
    expect(prompt).not.toContain("Missing path");
    expect(prompt).not.toContain("Blank path");
    expect(prompt.indexOf("## AGENTS.md")).toBeLessThan(prompt.indexOf("## ./SOUL.md"));
    expect(prompt.indexOf("## ./SOUL.md")).toBeLessThan(prompt.indexOf("## MEMORY.md"));
  });

  it("keeps model-visible channel ids stable across external registration order", () => {
    const activeRegistry = captureActivePluginRegistrySnapshot();
    const registrations = ["zeta-channel", "alpha-channel"].map((id) => ({
      pluginId: id,
      source: "test" as const,
      plugin: createChannelTestPluginBase({ id }),
    }));
    const buildPrompt = () => renderPrompt({ toolNames: ["message"] });

    try {
      setActivePluginRegistry(createTestRegistry(registrations));
      const firstPrompt = buildPrompt();
      setActivePluginRegistry(createTestRegistry(registrations.toReversed()));
      const secondPrompt = buildPrompt();

      expect(firstPrompt).toBe(secondPrompt);
      expect(firstPrompt).toContain(
        `ids: ${[...CHANNEL_IDS, "alpha-channel", "zeta-channel"].join("|")}.`,
      );
    } finally {
      restoreActivePluginRegistrySnapshot(activeRegistry);
    }
  });

  it("gates sub-agent orchestration guidance on available tools", () => {
    const messagingPrompt = renderPrompt({ toolNames: ["message", "sessions_send"] });
    const spawnOnlyPrompt = renderPrompt({ toolNames: ["sessions_spawn"] });
    const orchestrationPrompt = renderPrompt({ toolNames: ["sessions_spawn", "subagents"] });
    const orchestrationWaitPrompt = renderPrompt({
      toolNames: ["sessions_spawn", "sessions_yield", "subagents"],
    });

    expect(messagingPrompt).not.toContain("- Subagents:");
    expect(messagingPrompt).not.toContain("subagents(action=list)");

    expect(spawnOnlyPrompt).toContain("- Subagents: `sessions_spawn`");
    expect(spawnOnlyPrompt).not.toContain("subagents(action=list)");

    expect(orchestrationPrompt).toContain("`subagents(action=list)` only status/debug");
    expect(orchestrationWaitPrompt).toContain("Announcing children: wait via `sessions_yield`.");
  });

  it("keeps prefer delegation out of minimal prompts and conditions follow-up guidance", () => {
    const buildPreferPrompt = (toolNames: string[], promptMode?: "minimal") =>
      renderPrompt({ toolNames, promptMode, subagentDelegationMode: "prefer" });

    const withSend = buildPreferPrompt(["sessions_spawn", "sessions_send"]);
    const withoutSend = buildPreferPrompt(["sessions_spawn"]);
    const minimal = buildPreferPrompt(["sessions_spawn", "sessions_send"], "minimal");

    expect(withSend).toContain("follow up via `sessions_send`");
    expect(withoutSend).not.toContain("follow up via `sessions_send`");
    expect(minimal).not.toContain("## Delegation");
  });

  it("adds collapsible-details guidance only for supported full prompts", () => {
    const runtimeInfo = { channel: "webchat", capabilities: ["markdownDetails"] };
    const supported = buildPromptParts({ runtimeInfo });
    const unsupported = buildPromptParts({ runtimeInfo: { ...runtimeInfo, capabilities: [] } });
    expect(supported.suffix).toContain("## Collapsible Details");
    expect(unsupported.suffix).not.toContain("## Collapsible Details");
    expect(renderPrompt({ runtimeInfo, promptMode: "minimal" })).not.toContain(
      "## Collapsible Details",
    );
    expect(supported.prefix).toBe(unsupported.prefix);
  });

  it.each(["channel"] as const)(
    "describes message-tool-only source delivery for Discord %s without requiring target",
    (chatType) => {
      const prompt = renderPrompt({
        toolNames: ["message"],
        sourceReplyDeliveryMode: "message_tool_only",
        runtimeInfo: {
          channel: "discord",
          chatType,
        },
      });

      expect(prompt).toContain("Current source visible reply MUST use `message(action=send)`");
      expect(prompt).not.toContain("MEDIA:<path-or-url>");
      expect(prompt).toContain("Group/channel:");
      expect(prompt).toContain("current source is default target");
      expect(prompt).not.toContain("## Silent Replies");
      expect(prompt).not.toContain(SILENT_REPLY_TOKEN);
      expect(prompt).not.toContain("`send`: `target` + `message`.");
    },
  );

  it.each([
    { operation: "rewinds", sessionKey: "agent:work:main", runScoped: false },
    { operation: "isolated cron runs", sessionKey: "agent:work:cron:nightly-job", runScoped: true },
  ])("keeps runtime prompt bytes stable across $operation", ({ sessionKey, runScoped }) => {
    const buildForRun = (sessionId: string) => {
      const { runtimeInfo } = buildSystemPromptParams({
        config: { gateway: { publicOrigin: "https://gateway.example" } },
        agentId: "work",
        runtime: {
          sessionKey: runScoped ? `${sessionKey}:run:${sessionId}` : sessionKey,
          sessionId,
          host: "host",
          os: "linux",
          arch: "x64",
          node: "v24",
          model: "test/model",
        },
      });
      return buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", runtimeInfo });
    };
    const before = buildForRun("11111111-1111-1111-1111-111111111111");
    const after = buildForRun("22222222-2222-2222-2222-222222222222");

    expect(before).toContain(`session=${sessionKey}`);
    expect(after).toBe(before);
  });

  it("keys the stable directory roles by runtime cwd without moving agent files", () => {
    const params = { workspaceDir: "/tmp/openclaw", fsWorkspaceOnly: true };
    const prompts = ["/tmp/repo-a", "/tmp/repo-b", "/tmp/repo-a"].map((runtimeCwd) =>
      renderPrompt({ ...params, runtimeCwd }),
    );
    for (const [index, cwd] of ["/tmp/repo-a", "/tmp/repo-b"].entries()) {
      const prefix = prompts[index]!.split(SYSTEM_PROMPT_CACHE_BOUNDARY)[0];
      expect(prefix).toContain(`## Directory Roles\nWorking directory: ${cwd} (`);
      expect(prefix).toContain("Agent workspace: /tmp/openclaw");
      expect(prefix).not.toContain("## Workspace\n");
    }
    expect(prompts[2]).toBe(prompts[0]);
  });

  it("keeps exec-approval and authorized-sender guidance below the stable prefix", () => {
    const baseParams = {
      toolNames: ["message", "exec"],
      ownerNumbers: ["+123"],
      runtimeInfo: { channel: "webchat", capabilities: ["inlineButtons"] },
      contextFiles: [
        {
          path: "AGENTS.md",
          content: "Project rules mention ## Messaging, ## Group Chat Context, and ## Reactions.",
        },
      ],
      extraSystemPrompt: "Current group-chat facts",
      reactionGuidance: { level: "minimal", channel: "Telegram" },
      ttsHint: "Use short voice-friendly replies.",
    } satisfies Partial<PromptParams>;
    const prompt = renderPrompt(baseParams);
    const boundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(prompt.indexOf("# Project Context")).toBeGreaterThan(-1);
    expect(boundary).toBeGreaterThan(prompt.indexOf("# Project Context"));
    for (const section of [
      "## Messaging",
      "## Conversation Context",
      "## Reactions",
      "## Voice (TTS)",
      "native card/buttons first",
      "## Authorized Senders",
    ]) {
      expect(prompt.lastIndexOf(section), section).toBeGreaterThan(boundary);
    }
    const otherOwnerPrompt = renderPrompt({ ...baseParams, ownerNumbers: ["+456"] });
    const manualApprovalPrompt = renderPrompt({
      ...baseParams,
      runtimeInfo: { channel: "webchat", capabilities: [] },
    });
    expect(otherOwnerPrompt).toContain("Allowlisted senders: +456");
    expect(otherOwnerPrompt).not.toContain("Allowlisted senders: +123");
    expect(manualApprovalPrompt).toContain("send exact /approve");
    expect(manualApprovalPrompt).not.toContain("native card/buttons first");
    for (const variant of [otherOwnerPrompt, manualApprovalPrompt]) {
      expect(variant.slice(0, variant.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY))).toBe(
        prompt.slice(0, boundary),
      );
    }
  });

  it("keeps automatic tool discovery in the stable prompt-cache prefix", () => {
    const toolSchemaDirectoryPrompt =
      "Available deferred-schema tools:\n- fake_calendar: Schedule an event";
    const prompt = renderPrompt({
      toolNames: ["tool_search", "tool_describe", "tool_call"],
      toolSchemaDirectoryPrompt,
    });
    const boundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(prompt).toContain("### Deferred Tool Schemas");
    expect(boundary).toBeGreaterThan(prompt.indexOf("### Deferred Tool Schemas"));
    expect(prompt.slice(0, boundary)).toContain(toolSchemaDirectoryPrompt);
  });
});

describe("watched sessions prompt surfaces", () => {
  it.each<PromptCase>([
    [
      "renders prepared watched sessions with titles, overflow, and recall guidance",
      {
        toolNames: ["sessions_list", "sessions_history", "sessions_search"],
        preparedWatchedSessions: {
          sessions: [
            { key: "agent:main:telegram:group:alpha", title: "Family group" },
            { key: "agent:main:telegram:group:beta" },
          ],
          hiddenCount: 1,
          readToolNames: ["sessions_history", "sessions_search"],
          listToolAvailable: true,
        },
      },
      [
        "## Watched Sessions",
        "Readable now (read-only) via sessions_history/sessions_search; rows appear in sessions_list.",
        "- agent:main:telegram:group:alpha — Family group",
        "- agent:main:telegram:group:beta",
        '(+1 more: sessions_list kinds=["group"].)',
        "before claiming no access",
      ],
    ],
    [
      "names only granted read tools and skips the sessions_list overflow hint without it",
      {
        toolNames: ["sessions_history"],
        preparedWatchedSessions: {
          sessions: [{ key: "agent:main:telegram:group:alpha" }],
          hiddenCount: 2,
          readToolNames: ["sessions_history"],
          listToolAvailable: false,
        },
      },
      ["Readable now (read-only) via sessions_history.", "(+2 more.)"],
      ["rows appear in sessions_list", 'sessions_list kinds=["group"]'],
    ],
  ])("%s", expectPromptCase);
});

function buildPromptParts(params: Partial<PromptParams>) {
  const prompt = renderPrompt({
    contextFiles: [{ path: "AGENTS.md", content: "Stable project instructions." }],
    ...params,
  });
  expect(prompt).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
  const [prefix, suffix] = prompt.split(SYSTEM_PROMPT_CACHE_BOUNDARY);
  return { prefix, suffix };
}

describe("system prompt memory and runtime cache boundary", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("hands prepared memory lines to synchronous prompt assembly", async () => {
    const prepare = vi.fn(async () => ["## Prepared Wiki", "Prepared before assembly.", ""]);
    registerMemoryPromptPreparation("memory-wiki", prepare);
    const preparedMemoryPrompt = await prepareAgentMemoryPrompt({
      enabled: true,
      toolNames: ["WIKI_SEARCH"],
      agentId: "main",
      agentSessionKey: "agent:main:main",
    });
    const prompt = renderPrompt({
      toolNames: ["WIKI_SEARCH"],
      runtimeInfo: { agentId: "main", sessionKey: "agent:main:main" },
      preparedMemoryPrompt,
    });
    expect(prompt).toContain("## Prepared Wiki\nPrepared before assembly.");
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it.each([{ toolNames: ["image_generate"], guidance: "Do not call `image_generate` again" }])(
    "keeps $toolNames guidance stable even without active work",
    ({ toolNames, guidance }) => {
      const available = buildPromptParts({ toolNames });
      expect(available.prefix).toContain(guidance);
      expect(buildPromptParts({ toolNames: [] }).prefix).not.toContain(guidance);
      expect(available.suffix).not.toContain(guidance);
    },
  );

  it.each<
    [
      name: string,
      params: Partial<PromptParams>,
      update: Partial<PromptParams>,
      prefix: [included: string[], excluded?: string[]],
      firstSuffix: [included: string[], excluded?: string[]],
      nextSuffix: [included: string[], excluded?: string[]],
    ]
  >([
    [
      "channel-dependent ACP routing",
      {
        toolNames: ["sessions_spawn"],
        acpEnabled: true,
        runtimeInfo: { channel: "discord", capabilities: ["threadbound-acp-spawn"] },
      },
      { runtimeInfo: { channel: "telegram", capabilities: [] } },
      [
        ["never route ACP through local subagent controls or a local PTY"],
        ["Discord ACP default:"],
      ],
      [["Discord ACP default:", 'ACP thread: only `sessions_spawn(runtime:"acp", thread:true)`']],
      [[], ["Discord ACP default:", "ACP thread:"]],
    ],
    [
      "ultra toggles",
      {
        toolNames: ["sessions_spawn", "sessions_send", "sessions_yield"],
        subagentDelegationMode: "prefer",
        proactiveSubagentOrchestration: false,
      },
      { proactiveSubagentOrchestration: true },
      [
        [
          "## Care",
          "Execute work directly by default. Delegate a bounded, independent task only when parallel execution or an independent review provides a concrete benefit. Keep dependent steps with the same owner.",
        ],
        ["## Proactive Sub-Agent Orchestration"],
      ],
      [["## Delegation"], ["Ultra active"]],
      [["## Proactive Sub-Agent Orchestration", "Ultra active"], ["## Delegation"]],
    ],
    [
      "elevated-level changes",
      {
        toolNames: ["exec"],
        sandboxInfo: {
          enabled: true,
          elevated: { allowed: true, fullAccessAvailable: true, defaultLevel: "ask" },
        },
      },
      {
        sandboxInfo: {
          enabled: true,
          elevated: { allowed: true, fullAccessAvailable: true, defaultLevel: "full" },
        },
      },
      [
        [
          "Subagents stay sandboxed without elevated/host access;",
          "User can toggle with /elevated on|off|ask|full.",
        ],
        ["Current elevated level:"],
      ],
      [["Current elevated level: ask"]],
      [["Current elevated level: full"]],
    ],
  ])(
    "keeps %s after stable authority guidance",
    (_name, params, update, prefix, firstSuffix, nextSuffix) => {
      const first = buildPromptParts(params);
      const next = buildPromptParts({ ...params, ...update });
      expect(next.prefix).toBe(first.prefix);
      expectPromptText(first.prefix, ...prefix);
      expectPromptText(first.suffix, ...firstSuffix);
      expectPromptText(next.suffix, ...nextSuffix);
    },
  );
});
