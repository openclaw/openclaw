import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import {
  AUTHORIZED_WHATSAPP_COMMAND,
  assertElevatedOffStatusReply,
  installDirectiveBehaviorE2EHooks,
  makeElevatedDirectiveConfig,
  makeRestrictedElevatedDisabledConfig,
  makeWhatsAppDirectiveConfig,
  replyText,
  runEmbeddedPiAgent,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

const COMMAND_MESSAGE_BASE = {
  From: "+1222",
  To: "+1222",
  CommandAuthorized: true,
} as const;

async function runCommand(
  home: string,
  body: string,
  options: { defaults?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
) {
  const res = await getReplyFromConfig(
    { ...COMMAND_MESSAGE_BASE, Body: body },
    {},
    makeWhatsAppDirectiveConfig(
      home,
      {
        model: "anthropic/claude-opus-4-5",
        ...options.defaults,
      },
      options.extra ?? {},
    ),
  );
  return replyText(res);
}

async function runElevatedCommand(home: string, body: string) {
  return getReplyFromConfig(
    { ...AUTHORIZED_WHATSAPP_COMMAND, Body: body },
    {},
    makeElevatedDirectiveConfig(home),
  );
}

async function runQueueDirective(home: string, body: string) {
  return runCommand(home, body);
}

function makeWorkElevatedAllowlistConfig(home: string) {
  const base = makeWhatsAppDirectiveConfig(
    home,
    {
      model: "anthropic/claude-opus-4-5",
    },
    {
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+1222", "+1333"] },
        },
      },
      channels: { whatsapp: { allowFrom: ["+1222", "+1333"] } },
    },
  );
  return {
    ...base,
    agents: {
      ...base.agents,
      list: [
        {
          id: "work",
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1333"] },
            },
          },
        },
      ],
    },
  };
}

function makeAllowlistedElevatedConfig(
  home: string,
  defaults: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return makeWhatsAppDirectiveConfig(
    home,
    {
      model: "anthropic/claude-opus-4-5",
      ...defaults,
    },
    {
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+1222"] },
        },
      },
      channels: { whatsapp: { allowFrom: ["+1222"] } },
      ...extra,
    },
  );
}

function makeCommandMessage(body: string, from = "+1222") {
  return {
    Body: body,
    From: from,
    To: from,
    Provider: "whatsapp",
    SenderE164: from,
    CommandAuthorized: true,
  } as const;
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("reports current directive defaults when no arguments are provided", async () => {
    await withTempHome(async (home) => {
      const verboseText = await runCommand(home, "/verbose", {
        defaults: { verboseDefault: "on" },
      });
      expect(verboseText).toContain("Current verbose level: on");
      expect(verboseText).toContain("Options: on, full, off.");

      const reasoningText = await runCommand(home, "/reasoning");
      expect(reasoningText).toContain("Current reasoning level: off");
      expect(reasoningText).toContain("Options: on, off, stream.");

      const elevatedText = replyText(await runElevatedCommand(home, "/elevated"));
      expect(elevatedText).toContain("Current elevated level: on");
      expect(elevatedText).toContain("Options: on, off, ask, full.");

      const execText = await runCommand(home, "/exec", {
        extra: {
          tools: {
            exec: {
              host: "gateway",
              security: "allowlist",
              ask: "always",
              node: "mac-1",
            },
          },
        },
      });
      expect(execText).toContain(
        "Current exec defaults: host=gateway, security=allowlist, ask=always, node=mac-1.",
      );
      expect(execText).toContain(
        "Options: host=sandbox|gateway|node, security=deny|allowlist|full, ask=off|on-miss|always, node=<id>.",
      );
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("persists elevated toggles across /status and /elevated", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      const offStatusText = replyText(await runElevatedCommand(home, "/elevated off\n/status"));
      expect(offStatusText).toContain("Session: agent:main:main");
      assertElevatedOffStatusReply(offStatusText);

      const offLevelText = replyText(await runElevatedCommand(home, "/elevated"));
      expect(offLevelText).toContain("Current elevated level: off");
      expect(loadSessionStore(storePath)["agent:main:main"]?.elevatedLevel).toBe("off");

      await runElevatedCommand(home, "/elevated on");
      const onStatusText = replyText(await runElevatedCommand(home, "/status"));
      const optionsLine = onStatusText?.split("\n").find((line) => line.trim().startsWith("⚙️"));
      expect(optionsLine).toBeTruthy();
      expect(optionsLine).toContain("elevated");

      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.elevatedLevel).toBe("on");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("enforces per-agent elevated restrictions and status visibility", async () => {
    await withTempHome(async (home) => {
      const deniedRes = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          SessionKey: "agent:restricted:main",
          CommandAuthorized: true,
        },
        {},
        makeRestrictedElevatedDisabledConfig(home) as unknown as OpenClawConfig,
      );
      const deniedText = replyText(deniedRes);
      expect(deniedText).toContain("agents.list[].tools.elevated.enabled");

      const statusRes = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          SessionKey: "agent:restricted:main",
          CommandAuthorized: true,
        },
        {},
        makeRestrictedElevatedDisabledConfig(home) as unknown as OpenClawConfig,
      );
      const statusText = replyText(statusRes);
      expect(statusText).not.toContain("elevated");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("applies per-agent allowlist requirements before allowing elevated", async () => {
    await withTempHome(async (home) => {
      const deniedRes = await getReplyFromConfig(
        {
          ...makeCommandMessage("/elevated on", "+1222"),
          SessionKey: "agent:work:main",
        },
        {},
        makeWorkElevatedAllowlistConfig(home),
      );

      const deniedText = replyText(deniedRes);
      expect(deniedText).toContain("agents.list[].tools.elevated.allowFrom.whatsapp");

      const allowedRes = await getReplyFromConfig(
        {
          ...makeCommandMessage("/elevated on", "+1333"),
          SessionKey: "agent:work:main",
        },
        {},
        makeWorkElevatedAllowlistConfig(home),
      );

      const allowedText = replyText(allowedRes);
      expect(allowedText).toContain("Elevated mode set to ask");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("handles runtime warning, invalid level, and multi-directive elevated inputs", async () => {
    await withTempHome(async (home) => {
      for (const scenario of [
        {
          body: "/elevated off",
          config: makeAllowlistedElevatedConfig(home, { sandbox: { mode: "off" } }),
          expectedSnippets: [
            "Elevated mode disabled.",
            "Runtime is direct; sandboxing does not apply.",
          ],
        },
        {
          body: "/elevated maybe",
          config: makeAllowlistedElevatedConfig(home),
          expectedSnippets: ["Unrecognized elevated level"],
        },
        {
          body: "/elevated off\n/verbose on",
          config: makeAllowlistedElevatedConfig(home),
          expectedSnippets: ["Elevated mode disabled.", "Verbose logging enabled."],
        },
      ]) {
        const res = await getReplyFromConfig(
          makeCommandMessage(scenario.body),
          {},
          scenario.config,
        );
        const text = replyText(res);
        for (const snippet of scenario.expectedSnippets) {
          expect(text).toContain(snippet);
        }
      }
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("persists queue overrides and reset behavior", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      const interruptText = await runQueueDirective(home, "/queue interrupt");
      expect(interruptText).toMatch(/^⚙️ Queue mode set to interrupt\./);
      let store = loadSessionStore(storePath);
      let entry = Object.values(store)[0];
      expect(entry?.queueMode).toBe("interrupt");

      const collectText = await runQueueDirective(
        home,
        "/queue collect debounce:2s cap:5 drop:old",
      );

      expect(collectText).toMatch(/^⚙️ Queue mode set to collect\./);
      expect(collectText).toMatch(/Queue debounce set to 2000ms/);
      expect(collectText).toMatch(/Queue cap set to 5/);
      expect(collectText).toMatch(/Queue drop set to old/);
      store = loadSessionStore(storePath);
      entry = Object.values(store)[0];
      expect(entry?.queueMode).toBe("collect");
      expect(entry?.queueDebounceMs).toBe(2000);
      expect(entry?.queueCap).toBe(5);
      expect(entry?.queueDrop).toBe("old");

      const resetText = await runQueueDirective(home, "/queue reset");
      expect(resetText).toMatch(/^⚙️ Queue mode reset to default\./);
      store = loadSessionStore(storePath);
      entry = Object.values(store)[0];
      expect(entry?.queueMode).toBeUndefined();
      expect(entry?.queueDebounceMs).toBeUndefined();
      expect(entry?.queueCap).toBeUndefined();
      expect(entry?.queueDrop).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("strips inline elevated directives from the user text (does not persist session override)", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const storePath = sessionStorePath(home);

      await getReplyFromConfig(
        {
          Body: "hello there /elevated off",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        makeElevatedDirectiveConfig(home),
      );

      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.elevatedLevel).toBeUndefined();

      const calls = vi.mocked(runEmbeddedPiAgent).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const call = calls[0]?.[0];
      expect(call?.prompt).toContain("hello there");
      expect(call?.prompt).not.toContain("/elevated");
    });
  });
});
