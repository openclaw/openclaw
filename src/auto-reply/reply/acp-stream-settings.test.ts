import { describe, expect, it } from "vitest";
import {
  isAcpTagVisible,
  resolveAcpProjectionSettings,
  resolveAcpStreamingConfig,
} from "./acp-stream-settings.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

describe("acp stream settings", () => {
  it("resolves stable defaults", () => {
    const settings = resolveAcpProjectionSettings(createAcpTestConfig());
    expect(settings.deliveryMode).toBe("final_only");
    expect(settings.repeatSuppression).toBe(true);
    expect(settings.maxTurnChars).toBe(24_000);
    expect(settings.maxMetaEventsPerTurn).toBe(64);
  });

  it("applies explicit stream overrides", () => {
    const settings = resolveAcpProjectionSettings(
      createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "final_only",
            repeatSuppression: false,
            maxTurnChars: 500,
            maxMetaEventsPerTurn: 7,
            tagVisibility: {
              usage_update: true,
            },
          },
        },
      }),
    );
    expect(settings.deliveryMode).toBe("final_only");
    expect(settings.repeatSuppression).toBe(false);
    expect(settings.maxTurnChars).toBe(500);
    expect(settings.maxMetaEventsPerTurn).toBe(7);
    expect(settings.tagVisibility.usage_update).toBe(true);
  });

  it("accepts explicit deliveryMode=live override", () => {
    const settings = resolveAcpProjectionSettings(
      createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
          },
        },
      }),
    );
    expect(settings.deliveryMode).toBe("live");
  });

  it("uses default tag visibility when no override is provided", () => {
    const settings = resolveAcpProjectionSettings(createAcpTestConfig());
    expect(isAcpTagVisible(settings, "tool_call")).toBe(true);
    expect(isAcpTagVisible(settings, "usage_update")).toBe(false);
  });

  it("respects tag visibility overrides", () => {
    const settings = resolveAcpProjectionSettings(
      createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            tagVisibility: {
              usage_update: true,
              tool_call: false,
            },
          },
        },
      }),
    );
    expect(isAcpTagVisible(settings, "usage_update")).toBe(true);
    expect(isAcpTagVisible(settings, "tool_call")).toBe(false);
  });

  it("resolves chunking/coalescing from ACP stream controls", () => {
    const streaming = resolveAcpStreamingConfig({
      cfg: createAcpTestConfig(),
      provider: "discord",
    });
    expect(streaming.chunking.maxChars).toBe(64);
    expect(streaming.coalescing.idleMs).toBe(0);
  });
});
