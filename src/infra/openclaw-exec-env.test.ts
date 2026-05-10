import { describe, expect, it } from "vitest";
import {
  ensureOpenClawExecMarkerOnProcess,
  markOpenClawAgentExecEnv,
  markOpenClawExecEnv,
  OPENCLAW_CLI_ENV_VALUE,
  OPENCLAW_CLI_ENV_VAR,
} from "./openclaw-exec-env.js";

describe("markOpenClawExecEnv", () => {
  it("returns a cloned env object with the exec marker set", () => {
    const env = { PATH: "/usr/bin", OPENCLAW_CLI: "0" };
    const marked = markOpenClawExecEnv(env);

    expect(marked).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
    expect(marked).not.toBe(env);
    expect(env.OPENCLAW_CLI).toBe("0");
  });
});

describe("ensureOpenClawExecMarkerOnProcess", () => {
  it.each([
    {
      name: "mutates and returns the provided process env",
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    },
    {
      name: "overwrites an existing marker on the provided process env",
      env: { PATH: "/usr/bin", [OPENCLAW_CLI_ENV_VAR]: "0" } as NodeJS.ProcessEnv,
    },
  ])("$name", ({ env }) => {
    expect(ensureOpenClawExecMarkerOnProcess(env)).toBe(env);
    expect(env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
  });

  it("defaults to mutating process.env when no env object is provided", () => {
    const previous = process.env[OPENCLAW_CLI_ENV_VAR];
    delete process.env[OPENCLAW_CLI_ENV_VAR];

    try {
      expect(ensureOpenClawExecMarkerOnProcess()).toBe(process.env);
      expect(process.env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
    } finally {
      if (previous === undefined) {
        delete process.env[OPENCLAW_CLI_ENV_VAR];
      } else {
        process.env[OPENCLAW_CLI_ENV_VAR] = previous;
      }
    }
  });
});

describe("markOpenClawAgentExecEnv", () => {
  it("adds the runtime agent id to exec child environments", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };

    expect(markOpenClawAgentExecEnv(env, "alex")).toBe(env);
    expect(env.OPENCLAW_AGENT_ID).toBe("alex");
    expect(env.AGENT_NAME).toBe("alex");
  });

  it("preserves an explicit AGENT_NAME while setting OPENCLAW_AGENT_ID", () => {
    const env: Record<string, string | undefined> = { AGENT_NAME: "custom-name" };

    markOpenClawAgentExecEnv(env, "vex");

    expect(env.OPENCLAW_AGENT_ID).toBe("vex");
    expect(env.AGENT_NAME).toBe("custom-name");
  });

  it("leaves env unchanged when no agent id is available", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };

    expect(markOpenClawAgentExecEnv(env, undefined)).toBe(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
