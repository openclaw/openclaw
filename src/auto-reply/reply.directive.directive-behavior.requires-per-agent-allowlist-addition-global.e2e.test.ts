import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it } from "vitest";
import {
  installDirectiveBehaviorE2EHooks,
  makeWhatsAppDirectiveConfig,
  replyText,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

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

function makeElevatedDirectiveConfig(
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

  it("requires per-agent allowlist in addition to global", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          SessionKey: "agent:work:main",
          CommandAuthorized: true,
        },
        {},
        makeWorkElevatedAllowlistConfig(home),
      );

      const text = replyText(res);
      expect(text).toContain("agents.list[].tools.elevated.allowFrom.whatsapp");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("allows elevated when both global and per-agent allowlists match", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          ...makeCommandMessage("/elevated on", "+1333"),
          SessionKey: "agent:work:main",
        },
        {},
        makeWorkElevatedAllowlistConfig(home),
      );

      const text = replyText(res);
      expect(text).toContain("Elevated mode set to ask");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("warns when elevated is used in direct runtime", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        makeCommandMessage("/elevated off"),
        {},
        makeElevatedDirectiveConfig(home, { sandbox: { mode: "off" } }),
      );

      const text = replyText(res);
      expect(text).toContain("Elevated mode disabled.");
      expect(text).toContain("Runtime is direct; sandboxing does not apply.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("rejects invalid elevated level", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        makeCommandMessage("/elevated maybe"),
        {},
        makeElevatedDirectiveConfig(home),
      );

      const text = replyText(res);
      expect(text).toContain("Unrecognized elevated level");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("handles multiple directives in a single message", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        makeCommandMessage("/elevated off\n/verbose on"),
        {},
        makeElevatedDirectiveConfig(home),
      );

      const text = replyText(res);
      expect(text).toContain("Elevated mode disabled.");
      expect(text).toContain("Verbose logging enabled.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
