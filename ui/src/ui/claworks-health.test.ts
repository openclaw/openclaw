import { describe, expect, it } from "vitest";
import {
  gatewayUrlToHttpOrigin,
  readClaworksApiKey,
  resolveClaworksRobotPluginConfig,
  summarizeClaworksAttention,
} from "./claworks-health.ts";

describe("claworks-health", () => {
  it("maps ws gateway URL to http origin", () => {
    expect(gatewayUrlToHttpOrigin("ws://127.0.0.1:18800")).toBe("http://127.0.0.1:18800");
    expect(gatewayUrlToHttpOrigin("wss://gw.example/openclaw")).toBe("https://gw.example");
  });

  it("reads api key from plugin config", () => {
    const cfg = resolveClaworksRobotPluginConfig({
      config: {
        plugins: {
          entries: {
            "claworks-robot": {
              enabled: true,
              config: { api: { api_key: "secret", require_api_key: true } },
            },
          },
        },
      },
    });
    expect(readClaworksApiKey(cfg)).toBe("secret");
  });

  it("summarizes missing api key attention", () => {
    const item = summarizeClaworksAttention({
      enabled: true,
      loading: false,
      error: null,
      httpOrigin: "http://127.0.0.1:18800",
      hasApiKey: false,
      requireApiKey: true,
      lastCheckedAt: Date.now(),
      payload: null,
      httpStatus: 401,
    });
    expect(item?.title).toContain("API key");
  });
});
