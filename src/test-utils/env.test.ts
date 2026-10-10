import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureFullEnv,
  deleteTestEnvValue,
  setTestEnvValue,
  withEnv,
  withEnvAsync,
  withPathResolutionEnv,
} from "./env.js";

describe("env test utils", () => {
  let original: ReturnType<typeof captureFullEnv>;
  beforeEach(() => {
    original = captureFullEnv();
  });
  afterEach(() => {
    deleteTestEnvValue("constructor");
    deleteTestEnvValue("toString");
    original.restore();
  });

  it("captureFullEnv distinguishes own keys from inherited prototype keys", () => {
    deleteTestEnvValue("constructor");
    setTestEnvValue("toString", "baseline");
    const snapshot = captureFullEnv();
    setTestEnvValue("constructor", "added");
    deleteTestEnvValue("toString");

    snapshot.restore();

    expect(Object.hasOwn(process.env, "constructor")).toBe(false);
    expect(Object.entries(process.env).find(([key]) => key === "toString")?.[1]).toBe("baseline");
  });

  it("withEnv applies values only inside callback", () => {
    const key = "OPENCLAW_ENV_TEST_SYNC";
    const prev = process.env[key];
    expect(withEnv({ [key]: "inside" }, () => process.env[key])).toBe("inside");
    expect(process.env[key]).toBe(prev);
  });

  it("withEnv restores values when callback throws", () => {
    const key = "OPENCLAW_ENV_TEST_SYNC_THROW";
    const prev = process.env[key];
    expect(() =>
      withEnv({ [key]: "inside" }, () => {
        expect(process.env[key]).toBe("inside");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.env[key]).toBe(prev);
  });

  it("withEnv can delete a key only inside callback", () => {
    const key = "OPENCLAW_ENV_TEST_SYNC_DELETE";
    setTestEnvValue(key, "outer");
    expect(withEnv({ [key]: undefined }, () => process.env[key])).toBeUndefined();
    expect(process.env[key]).toBe("outer");
  });

  it("withEnvAsync restores values when callback throws", async () => {
    const key = "OPENCLAW_ENV_TEST_ASYNC";
    const prev = process.env[key];
    await expect(
      withEnvAsync({ [key]: "inside" }, async () => {
        expect(process.env[key]).toBe("inside");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env[key]).toBe(prev);
  });

  it("withEnvAsync applies values only inside async callback", async () => {
    const key = "OPENCLAW_ENV_TEST_ASYNC_OK";
    const prev = process.env[key];
    const seen = await withEnvAsync({ [key]: "inside" }, async () => process.env[key]);
    expect(seen).toBe("inside");
    expect(process.env[key]).toBe(prev);
  });

  it("withPathResolutionEnv clears leaked overrides and scopes explicit paths to the callback", () => {
    const homeDir = path.join(path.sep, "tmp", "openclaw-home");
    const inherited = {
      OPENCLAW_HOME: "/srv/openclaw-home",
      OPENCLAW_STATE_DIR: "/srv/openclaw-state",
      OPENCLAW_BUNDLED_PLUGINS_DIR: "/srv/openclaw-bundled",
    };
    for (const [key, value] of Object.entries(inherited)) {
      setTestEnvValue(key, value);
    }

    withPathResolutionEnv(homeDir, { OPENCLAW_STATE_DIR: "~/state" }, (env) => {
      for (const scope of [process.env, env]) {
        expect(scope.HOME).toBe(path.resolve(homeDir));
        expect(scope.OPENCLAW_HOME).toBeUndefined();
        expect(scope.OPENCLAW_BUNDLED_PLUGINS_DIR).toBeUndefined();
        expect(scope.OPENCLAW_STATE_DIR).toBe("~/state");
      }
    });

    for (const [key, value] of Object.entries(inherited)) {
      expect(process.env[key]).toBe(value);
    }
  });
});
