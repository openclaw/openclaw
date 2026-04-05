import { describe, expect, it } from "vitest";
import {
  ensureMullusiExecMarkerOnProcess,
  markMullusiExecEnv,
  MULLUSI_CLI_ENV_VALUE,
  MULLUSI_CLI_ENV_VAR,
} from "./mullusi-exec-env.js";

describe("markMullusiExecEnv", () => {
  it("returns a cloned env object with the exec marker set", () => {
    const env = { PATH: "/usr/bin", MULLUSI_CLI: "0" };
    const marked = markMullusiExecEnv(env);

    expect(marked).toEqual({
      PATH: "/usr/bin",
      MULLUSI_CLI: MULLUSI_CLI_ENV_VALUE,
    });
    expect(marked).not.toBe(env);
    expect(env.MULLUSI_CLI).toBe("0");
  });
});

describe("ensureMullusiExecMarkerOnProcess", () => {
  it.each([
    {
      name: "mutates and returns the provided process env",
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    },
    {
      name: "overwrites an existing marker on the provided process env",
      env: { PATH: "/usr/bin", [MULLUSI_CLI_ENV_VAR]: "0" } as NodeJS.ProcessEnv,
    },
  ])("$name", ({ env }) => {
    expect(ensureMullusiExecMarkerOnProcess(env)).toBe(env);
    expect(env[MULLUSI_CLI_ENV_VAR]).toBe(MULLUSI_CLI_ENV_VALUE);
  });

  it("defaults to mutating process.env when no env object is provided", () => {
    const previous = process.env[MULLUSI_CLI_ENV_VAR];
    delete process.env[MULLUSI_CLI_ENV_VAR];

    try {
      expect(ensureMullusiExecMarkerOnProcess()).toBe(process.env);
      expect(process.env[MULLUSI_CLI_ENV_VAR]).toBe(MULLUSI_CLI_ENV_VALUE);
    } finally {
      if (previous === undefined) {
        delete process.env[MULLUSI_CLI_ENV_VAR];
      } else {
        process.env[MULLUSI_CLI_ENV_VAR] = previous;
      }
    }
  });
});
