import { describe, expect, it } from "vitest";
import {
  ensureOpenClawExecMarkerOnProcess,
  markOpenClawChildCommandEnv,
  markOpenClawCliEnv,
  NO_DNA_ENV_VALUE,
  OPENCLAW_CLI_ENV_VALUE,
  OPENCLAW_CLI_ENV_VAR,
} from "./openclaw-exec-env.js";

describe("markOpenClawCliEnv", () => {
  it("returns a cloned env object with the cli marker set", () => {
    const env = { PATH: "/usr/bin", OPENCLAW_CLI: "0" };
    const marked = markOpenClawCliEnv(env);

    expect(marked).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
    expect(marked).not.toBe(env);
    expect(env.OPENCLAW_CLI).toBe("0");
  });
});

describe("markOpenClawChildCommandEnv", () => {
  it("adds child command markers", () => {
    expect(markOpenClawChildCommandEnv({ PATH: "/usr/bin" })).toEqual({
      NO_DNA: NO_DNA_ENV_VALUE,
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      PATH: "/usr/bin",
    });
  });
});

describe("ensureOpenClawExecMarkerOnProcess", () => {
  it("mutates and returns the provided process env", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    expect(ensureOpenClawExecMarkerOnProcess(env)).toBe(env);
    expect(env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.NO_DNA).toBeUndefined();
  });

  it("defaults to mutating process.env when no env object is provided", () => {
    const previous = process.env[OPENCLAW_CLI_ENV_VAR];
    const previousNoDna = process.env.NO_DNA;
    delete process.env[OPENCLAW_CLI_ENV_VAR];
    delete process.env.NO_DNA;

    try {
      expect(ensureOpenClawExecMarkerOnProcess()).toBe(process.env);
      expect(process.env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
      expect(process.env.NO_DNA).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env[OPENCLAW_CLI_ENV_VAR];
      } else {
        process.env[OPENCLAW_CLI_ENV_VAR] = previous;
      }
      if (previousNoDna === undefined) {
        delete process.env.NO_DNA;
      } else {
        process.env.NO_DNA = previousNoDna;
      }
    }
  });
});
