import { describe, expect, it } from "vitest";
import { captureEnv, captureFullEnv, withEnv, withEnvAsync } from "./env.js";

describe("env test utils", () => {
  it("captureEnv restores mutated keys", () => {
    const keyA = "OPENCLAW_ENV_TEST_A";
    const keyB = "OPENCLAW_ENV_TEST_B";
    const snapshot = captureEnv([keyA, keyB]);
    const prevA = process.env[keyA];
    const prevB = process.env[keyB];
    process.env[keyA] = "mutated";
    delete process.env[keyB];

    snapshot.restore();

    expect(process.env[keyA]).toBe(prevA);
    expect(process.env[keyB]).toBe(prevB);
  });

  it("captureFullEnv restores added keys and baseline values", () => {
    const key = "OPENCLAW_ENV_TEST_ADDED";
    const prevHome = process.env.HOME;
    const snapshot = captureFullEnv();
    process.env[key] = "1";
    delete process.env.HOME;

    snapshot.restore();

    expect(process.env[key]).toBeUndefined();
    expect(process.env.HOME).toBe(prevHome);
  });

  it("withEnv applies values only inside callback", () => {
    const key = "OPENCLAW_ENV_TEST_SYNC";
    const prev = process.env[key];

    const seen = withEnv({ [key]: "inside" }, () => process.env[key]);

    expect(seen).toBe("inside");
    expect(process.env[key]).toBe(prev);
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
});
