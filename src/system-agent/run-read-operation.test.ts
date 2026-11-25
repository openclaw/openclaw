import { describe, expect, it } from "vitest";
import { resolveSystemAgentRunRead } from "./run-read-operation.js";

describe("system agent run classification", () => {
  it.each([
    [["status"], { kind: "status" }],
    [["health"], { kind: "health" }],
    [["config", "validate"], { kind: "config-validate" }],
    [["config", "schema"], { kind: "config-schema" }],
    [["daemon", "status"], { kind: "gateway-status" }],
    [["daemon", "status", "--deep"], { kind: "gateway-status-deep" }],
    [["plugins", "list"], { kind: "plugin-list" }],
    [["plugins", "doctor"], { kind: "plugins-doctor" }],
    [["models", "status"], { kind: "models-status" }],
    [["channels", "status"], { kind: "channels-status" }],
    [["channels", "status", "--probe"], { kind: "channels-status", probe: true }],
  ] as const)("maps %j to a protected read", (argv, operation) => {
    expect(resolveSystemAgentRunRead(argv)).toEqual(operation);
  });

  it.each([
    [["logs", "--follow"]],
    [["logs", "--limit", "50"]],
    [["onboard"]],
    [["configure"]],
    [["setup"]],
    [["qr"]],
    [["doctor", "--lint"]],
    [["doctor", "--fix"]],
    [["config", "file"]],
    [["config", "set", "logging.level"]],
    [["config", "get", "--json"]],
    [["config", "get", "gateway.port", "--json"]],
    [["config", "get", "gateway.\nport"]],
    [["status", "--profile", "other"]],
    [["status", "--json"]],
    [["models", "status", "--check"]],
    [["gateway", "status", "--url", "ws://example.invalid"]],
    [["gateway", "status", "--deep", "--require-rpc"]],
    [["plugins", "inspect", "demo"]],
    [["skills", "info", "weather"]],
    [["skills", "check", "--agent", "work"]],
    [["docs", "gateway"]],
    [["reset"]],
    [["gateway status"]],
    [[]],
  ] as const)("refuses %j without a fallback CLI route", (argv) => {
    expect(resolveSystemAgentRunRead(argv)).toBeUndefined();
  });
});
