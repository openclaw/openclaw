import { describe, expect, it } from "vitest";
import {
  ensureOpenClawExecMarkerOnProcess,
  markOpenClawExecEnv,
  OPENCLAW_CLI_ENV_VALUE,
  OPENCLAW_CLI_ENV_VAR,
  OPENCLAW_SERVICE_RUNTIME_ENV_VARS,
  stripOpenClawServiceRuntimeEnv,
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

describe("stripOpenClawServiceRuntimeEnv", () => {
  it("removes OpenClaw service runtime markers while preserving other env vars", () => {
    const stripped = stripOpenClawServiceRuntimeEnv({
      PATH: "/usr/bin",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_SERVICE_VERSION: "2026.3.13",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway",
      KEEP: "1",
    });

    expect(stripped).toEqual({
      PATH: "/usr/bin",
      KEEP: "1",
    });
  });

  it("tracks the full OpenClaw service runtime marker set", () => {
    expect(OPENCLAW_SERVICE_RUNTIME_ENV_VARS).toEqual([
      "OPENCLAW_LAUNCHD_LABEL",
      "OPENCLAW_SYSTEMD_UNIT",
      "OPENCLAW_WINDOWS_TASK_NAME",
      "OPENCLAW_SERVICE_MARKER",
      "OPENCLAW_SERVICE_KIND",
      "OPENCLAW_SERVICE_VERSION",
    ]);
  });
});
