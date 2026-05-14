import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO, resetConfigRuntimeState } from "./io.js";

describe("config validation surfaces did-you-mean hints", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-did-you-mean-",
  });
  const silentLogger = { warn: () => {}, error: () => {} };

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("suggests gateway.port when the user writes a typo for the port key", async () => {
    const home = await suiteRootTracker.make("typo-port");
    const io = createConfigIO({
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: silentLogger,
    });

    // "porrt" is one transposition away from "port".
    await expect(
      io.writeConfigFile({ gateway: { mode: "local", porrt: 18789 } as never }),
    ).rejects.toThrow(/did you mean.*"port"/);
  });

  it("does not append a did-you-mean clause when the unknown key is too far from any valid key", async () => {
    const home = await suiteRootTracker.make("typo-far");
    const io = createConfigIO({
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: silentLogger,
    });

    let captured: Error | null = null;
    try {
      await io.writeConfigFile({
        gateway: { mode: "local", absolutelyNotAKey: 18789 } as never,
      });
    } catch (err) {
      captured = err as Error;
    }

    expect(captured, "expected writeConfigFile to throw a validation error").toBeTruthy();
    expect(captured?.message).not.toContain("did you mean");
  });
});
