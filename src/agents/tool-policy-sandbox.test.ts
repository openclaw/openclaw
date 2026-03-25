import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import {
  formatEffectiveSandboxToolPolicyBlockedMessage,
  isToolAllowedBySandboxToolPolicy,
  resolveEffectiveSandboxToolPolicyForAgent,
} from "./tool-policy-sandbox.js";

describe("tool-policy-sandbox", () => {
  it("merges sandbox alsoAllow into the default sandbox allowlist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
    };

    const resolved = resolveEffectiveSandboxToolPolicyForAgent(cfg, "tavern");
    expect(resolved.allow).toContain("message");
    expect(resolved.allow).toContain("tts");
    expect(resolved.sources.allow).toEqual({
      source: "agent",
      key: "agents.list[].tools.sandbox.tools.alsoAllow",
    });
  });

  it("lets explicit sandbox allow remove entries from the default sandbox denylist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
    };

    const resolved = resolveEffectiveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.allow).toContain("browser");
    expect(resolved.deny).not.toContain("browser");
    expect(
      isToolAllowedBySandboxToolPolicy("browser", {
        allow: resolved.allow,
        deny: resolved.deny,
      }),
    ).toBe(true);
  });

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            allow: [],
            alsoAllow: ["browser"],
          },
        },
      },
    };

    const resolved = resolveEffectiveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.allow).toEqual([]);
    expect(resolved.deny).not.toContain("browser");
    expect(
      isToolAllowedBySandboxToolPolicy("read", {
        allow: resolved.allow,
        deny: resolved.deny,
      }),
    ).toBe(true);
    expect(
      isToolAllowedBySandboxToolPolicy("browser", {
        allow: resolved.allow,
        deny: resolved.deny,
      }),
    ).toBe(true);
  });

  it("keeps canonical sandbox config and runtime status aligned with the effective resolver", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "tavern");
    expect(sandbox.tools.allow).toEqual(expect.arrayContaining(["browser", "message", "tts"]));
    expect(sandbox.tools.deny).not.toContain("browser");

    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:tavern:main",
    });
    expect(runtime.toolPolicy.allow).toEqual(expect.arrayContaining(["browser", "message", "tts"]));
    expect(runtime.toolPolicy.deny).not.toContain("browser");
  });

  it("keeps explicit sandbox deny precedence over allow and alsoAllow", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
            alsoAllow: ["message"],
            deny: ["browser", "message"],
          },
        },
      },
    };

    const resolved = resolveEffectiveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.deny).toContain("browser");
    expect(resolved.deny).toContain("message");
    expect(
      isToolAllowedBySandboxToolPolicy("browser", {
        allow: resolved.allow,
        deny: resolved.deny,
      }),
    ).toBe(false);
    expect(
      isToolAllowedBySandboxToolPolicy("message", {
        allow: resolved.allow,
        deny: resolved.deny,
      }),
    ).toBe(false);
  });

  it("uses the effective sandbox policy when formatting blocked-tool guidance", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            alsoAllow: ["message"],
          },
        },
      },
    };

    const browserMessage = formatEffectiveSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey: "agent:main:main",
      toolName: "browser",
    });
    expect(browserMessage).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(browserMessage).toContain("tools.sandbox.tools.deny");

    const messageToolMessage = formatEffectiveSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey: "agent:main:main",
      toolName: "message",
    });
    expect(messageToolMessage).toBeUndefined();
  });
});
