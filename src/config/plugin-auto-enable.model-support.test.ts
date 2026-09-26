// Verifies model-support based plugin auto-enable decisions.
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";

afterEach(resetPluginAutoEnableTestState);

describe("applyPluginAutoEnable modelSupport", () => {
  it("auto-enables provider plugins from shorthand modelSupport ownership", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "gpt-5.4",
          },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "openai",
          channels: [],
          modelSupport: {
            modelPrefixes: ["gpt-", "o1", "o3", "o4"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(result.changes).toContain("gpt-5.4 model configured, enabled automatically.");
  });

  it("skips ambiguous shorthand model ownership during auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "gpt-5.4",
          },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "openai",
          channels: [],
          modelSupport: {
            modelPrefixes: ["gpt-"],
          },
        },
        {
          id: "proxy-openai",
          channels: [],
          modelSupport: {
            modelPrefixes: ["gpt-"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai).toBeUndefined();
    expect(result.config.plugins?.entries?.["proxy-openai"]).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });
});
