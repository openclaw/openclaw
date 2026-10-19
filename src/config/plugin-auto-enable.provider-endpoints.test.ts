// Covers endpoint-driven plugin auto-enable for custom provider ids.
import { afterAll, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";

const env = makeIsolatedEnv();

afterAll(() => {
  resetPluginAutoEnableTestState();
});

const qwenPlugin = {
  id: "qwen",
  channels: [],
  origin: "bundled" as const,
  providers: ["qwen", "modelstudio", "dashscope"],
  providerEndpoints: [
    {
      endpointClass: "modelstudio-native",
      baseUrls: ["https://dashscope.aliyuncs.com/compatible-mode/v1"],
    },
  ],
};

describe("plugin auto-enable declared provider endpoints", () => {
  it("activates the endpoint owner for a custom provider id", () => {
    const result = applyPluginAutoEnable({
      config: {
        models: {
          providers: {
            "custom-dashscope": {
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              models: [],
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([qwenPlugin]),
    });
    expect(result.config.plugins?.entries?.qwen?.enabled).toBe(true);
    expect(result.autoEnabledReasons).toEqual({
      qwen: ["custom-dashscope provider endpoint configured"],
    });
  });

  it("keeps an exact registered provider id on its id-based reason", () => {
    const result = applyPluginAutoEnable({
      config: {
        models: {
          providers: {
            dashscope: {
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              models: [],
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        { ...qwenPlugin, autoEnableWhenConfiguredProviders: ["dashscope"] },
      ]),
    });
    expect(result.config.plugins?.entries?.qwen?.enabled).toBe(true);
    expect(result.autoEnabledReasons).toEqual({ qwen: ["dashscope auth configured"] });
  });

  it("leaves a custom provider id without a declared endpoint alone", () => {
    const result = applyPluginAutoEnable({
      config: {
        models: {
          providers: {
            "custom-endpoint": { baseUrl: "https://llm.example.test/v1", models: [] },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([qwenPlugin]),
    });
    expect(result.config.plugins?.entries?.qwen).toBeUndefined();
    expect(result.autoEnabledReasons).toEqual({});
  });

  it("matches a declared host suffix for a custom provider id", () => {
    const result = applyPluginAutoEnable({
      config: {
        models: {
          providers: {
            "custom-intl": {
              baseUrl: "https://team.dashscope-intl.aliyuncs.com/compatible-mode/v1",
              models: [],
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "qwen",
          channels: [],
          origin: "bundled",
          providers: ["qwen"],
          providerEndpoints: [
            {
              endpointClass: "modelstudio-native",
              hostSuffixes: ["dashscope-intl.aliyuncs.com"],
            },
          ],
        },
      ]),
    });
    expect(result.autoEnabledReasons).toEqual({
      qwen: ["custom-intl provider endpoint configured"],
    });
  });

  it("does not widen a restrictive plugin allowlist for an endpoint-only match", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["other"],
          entries: { other: { enabled: true } },
        },
        models: {
          providers: {
            "custom-dashscope": {
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              models: [],
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([
        qwenPlugin,
        { id: "other", channels: [], origin: "bundled" },
      ]),
    });
    expect(result.config.plugins?.allow).toEqual(["other"]);
    expect(result.config.plugins?.entries?.qwen).toBeUndefined();
    expect(result.autoEnabledReasons).toEqual({});
  });

  it("does not activate a denied endpoint owner", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: { deny: ["qwen"] },
        models: {
          providers: {
            "custom-dashscope": {
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              models: [],
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([qwenPlugin]),
    });
    expect(result.config.plugins?.entries?.qwen).toBeUndefined();
    expect(result.autoEnabledReasons).toEqual({});
  });

  it("does not activate an explicitly disabled endpoint owner", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: { entries: { qwen: { enabled: false } } },
        models: {
          providers: {
            "custom-dashscope": {
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              models: [],
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([qwenPlugin]),
    });
    expect(result.config.plugins?.entries?.qwen).toEqual({ enabled: false });
    expect(result.autoEnabledReasons).toEqual({});
  });

  it("does not activate an untrusted workspace endpoint owner", () => {
    const result = applyPluginAutoEnable({
      config: {
        models: {
          providers: {
            "custom-dashscope": {
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              models: [],
            },
          },
        },
      },
      env,
      manifestRegistry: makeRegistry([{ ...qwenPlugin, origin: "workspace" }]),
    });
    expect(result.config.plugins?.entries?.qwen).toBeUndefined();
    expect(result.autoEnabledReasons).toEqual({});
  });
});
