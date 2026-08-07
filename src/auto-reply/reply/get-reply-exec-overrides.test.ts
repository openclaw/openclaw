// Tests execution override directives passed through get-reply.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import {
  type ReplyExecOverrides,
  resolveConfigExecDefaults,
  resolveReplyExecOverrides,
} from "./get-reply-exec-overrides.js";

const AGENT_EXEC_DEFAULTS = {
  host: "node",
  security: "allowlist",
  ask: "always",
  node: "worker-alpha",
} as const satisfies ReplyExecOverrides;

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "main",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function withGlobalExec(exec: NonNullable<OpenClawConfig["tools"]>["exec"]): OpenClawConfig {
  return {
    tools: { exec },
  };
}

function withAgentExec(
  globalExec: NonNullable<OpenClawConfig["tools"]>["exec"],
  agentExec: NonNullable<NonNullable<OpenClawConfig["tools"]>["exec"]>,
  agentId = "main",
): OpenClawConfig {
  return {
    tools: { exec: globalExec },
    agents: {
      entries: {
        [agentId]: {
          tools: { exec: agentExec },
        },
      },
    },
  };
}

describe("resolveConfigExecDefaults", () => {
  it("inherits global tools.exec for new sessions without agent overrides (#112376)", () => {
    expect(
      resolveConfigExecDefaults({
        cfg: withGlobalExec({
          host: "gateway",
          security: "full",
          ask: "off",
        }),
      }),
    ).toEqual({
      host: "gateway",
      security: "full",
      ask: "off",
      node: undefined,
    });
  });

  it("preserves mode:auto so downstream layering keeps automatic review (#112376)", () => {
    expect(
      resolveConfigExecDefaults({
        cfg: withGlobalExec({
          host: "gateway",
          mode: "auto",
        }),
      }),
    ).toEqual({
      host: "gateway",
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
      node: undefined,
    });
  });

  it("lets per-agent tools.exec override global defaults", () => {
    expect(
      resolveConfigExecDefaults({
        cfg: withAgentExec(
          {
            host: "gateway",
            security: "full",
            ask: "off",
          },
          {
            host: "node",
            security: "allowlist",
            ask: "on-miss",
            node: "worker-alpha",
          },
        ),
        agentId: "main",
      }),
    ).toEqual({
      host: "node",
      security: "allowlist",
      ask: "on-miss",
      node: "worker-alpha",
    });
  });

  it("does not seed unsupported tools.exec.nodeCwd from persistent config (#112376)", () => {
    expect(
      resolveConfigExecDefaults({
        cfg: withAgentExec(
          {
            host: "node",
            security: "full",
            ask: "off",
            node: "worker-a",
            // @ts-expect-error nodeCwd is outside ExecToolConfig
            nodeCwd: "/global/workdir",
          },
          {
            node: "worker-b",
            // @ts-expect-error nodeCwd is outside ExecToolConfig
            nodeCwd: "/agent/workdir",
          },
        ),
        agentId: "main",
      }),
    ).toEqual({
      host: "node",
      security: "full",
      ask: "off",
      node: "worker-b",
    });
  });

  it("derives security/ask from tools.exec.mode so reply overrides can clear a stricter mode", () => {
    expect(
      resolveConfigExecDefaults({
        cfg: withGlobalExec({
          host: "gateway",
          mode: "full",
        }),
      }),
    ).toEqual({
      host: "gateway",
      mode: "full",
      security: "full",
      ask: "off",
      node: undefined,
    });
  });

  it("keeps canonical mode precedence when a layer mixes mode with security/ask", () => {
    expect(
      resolveConfigExecDefaults({
        cfg: withGlobalExec({
          host: "gateway",
          mode: "deny",
          security: "full",
          ask: "off",
        }),
      }),
    ).toEqual({
      host: "gateway",
      mode: "deny",
      security: "deny",
      ask: "off",
      node: undefined,
    });
  });

  it("returns undefined when neither global nor agent exec policy is configured", () => {
    expect(resolveConfigExecDefaults({})).toBeUndefined();
  });
});

describe("reply exec overrides", () => {
  it("uses per-agent exec defaults when session and message are unset", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual(AGENT_EXEC_DEFAULTS);
  });

  it("surfaces global tools.exec through reply overrides when the session has no exec fields (#112376)", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: resolveConfigExecDefaults({
          cfg: withGlobalExec({
            host: "gateway",
            security: "full",
            ask: "off",
          }),
        }),
      }),
    ).toEqual({
      host: "gateway",
      security: "full",
      ask: "off",
      node: undefined,
    });
  });

  it("carries mode:auto for a fresh session without session/inline policy overrides", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: resolveConfigExecDefaults({
          cfg: withGlobalExec({
            host: "gateway",
            mode: "auto",
          }),
        }),
      }),
    ).toEqual({
      host: "gateway",
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
      node: undefined,
    });
  });

  it("keeps fresh-session node without inventing persistent nodeCwd (#112376)", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: resolveConfigExecDefaults({
          cfg: withGlobalExec({
            host: "node",
            security: "full",
            ask: "off",
            node: "worker-alpha",
          }),
        }),
      }),
    ).toEqual({
      host: "node",
      security: "full",
      ask: "off",
      node: "worker-alpha",
    });
  });

  it("does not let defaults nodeCwd cross an agent-selected node (#112376)", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: {
          host: "node",
          node: "worker-b",
          // Stale runtime residue must not become an explicit cwd override.
          nodeCwd: "/Users/demo/worker-a-workdir",
        },
      }),
    ).toEqual({
      host: "node",
      security: undefined,
      ask: undefined,
      node: "worker-b",
    });
  });

  it("prefers inline exec directives, then persisted session overrides, then agent defaults", () => {
    const sessionEntry = createSessionEntry({
      execHost: "gateway",
      execSecurity: "deny",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec host=auto security=full"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "auto",
      security: "full",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "gateway",
      security: "deny",
    });
  });

  it("uses persisted session exec fields for later turns", () => {
    const sessionEntry = createSessionEntry({
      execHost: "gateway",
      execSecurity: "full",
      execAsk: "always",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "gateway",
      security: "full",
      ask: "always",
    });
  });

  it("carries the node cwd separately from the Gateway workspace", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry({
          execHost: "node",
          execNode: "macbook",
          execCwd: "/Users/peter/Projects/openclaw",
        }),
      }),
    ).toEqual({
      host: "node",
      security: undefined,
      ask: undefined,
      node: "macbook",
      nodeCwd: "/Users/peter/Projects/openclaw",
    });
  });

  it("does not carry a stored cwd across an inline node override", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec node=other-node"),
        sessionEntry: createSessionEntry({
          execHost: "node",
          execNode: "macbook",
          execCwd: "/Users/peter/Projects/openclaw",
        }),
        agentExecDefaults: {
          host: "node",
          node: "macbook",
        },
      }),
    ).toEqual({
      host: "node",
      security: undefined,
      ask: undefined,
      node: "other-node",
    });
  });
});
