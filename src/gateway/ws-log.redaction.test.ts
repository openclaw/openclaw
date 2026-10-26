import { channel } from "node:diagnostics_channel";
import { stripVTControlCharacters } from "node:util";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { logWs } from "./ws-log.js";
import { setGatewayWsLogStyle } from "./ws-logging.js";

const output = vi.hoisted(() => {
  // Runtime setup can preload redaction before the compiler spy is installed.
  vi.resetModules();
  return vi.fn<(message: string) => void>();
});
vi.mock("../security/config-regex.js", { spy: true });
vi.mock("../logging/config.js", () => ({
  readLoggingConfig: () => ({ redactPatterns: ["ordinary"] }),
}));
// mock-isolation: Capture log output without creating real logger state or sinks.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ isEnabled: () => true, info: output, warn: output }),
}));
beforeEach(() => {
  setVerbose(true);
  setGatewayWsLogStyle("full");
  output.mockClear();
  return () => {
    setVerbose(false);
    setGatewayWsLogStyle("auto");
  };
});
function logFrame(detail: unknown, count = 1): void {
  for (let index = 0; index < count; index += 1) {
    logWs("out", "res", { method: "health", ok: true, detail, id: "frame" });
  }
}

test("compiles the default patterns only once across repeated WS frames", () => {
  const compile = vi.mocked(compileConfigRegex);
  const initialCalls = compile.mock.calls.length;
  logFrame("token=synthetic-value");
  const firstFrameCalls = compile.mock.calls.length;
  expect(firstFrameCalls).toBeGreaterThan(initialCalls);
  logFrame("token=synthetic-value", 20);
  expect(compile.mock.calls.length).toBe(firstFrameCalls);
});

test("skips the default pattern walk for WS frames without candidate substrings", () => {
  const source = channel("openclaw.redaction");
  const measurements: unknown[] = [];
  const listener = (message: unknown) => measurements.push(message);
  source.subscribe(listener);
  onTestFinished(() => source.unsubscribe(listener));
  logFrame("token=synthetic-value");
  expect(measurements).toContainEqual(expect.objectContaining({ operation: "text" }));
  measurements.length = 0;
  logFrame("ordinary response completed", 20);
  expect(measurements).toHaveLength(0);
});
test.each([
  ["ordinary response completed", "ordinary response completed"],
  ["sk-abcdefghijklmnopqrstuvwxyz123456", "sk-abc…3456"],
  ["prefixSG.abcdefghijk.abcdefghijk", "prefixSG.abc…hijk"],
  [{ token: "sk-abcdefghijklmnopqrstuvwxyz123456" }, '{"token":"sk-abc…3456"}'],
  [new Error("password=synthetic-value"), "Error: password=***"],
  [{ message: "token=synthetic-value", code: "E1" }, "token=*** code=E1"],
  ["to%6ben\u3164=synthetic-value&mode=read", "to%6ben\u3164=***&mode=read"],
  [
    "-----BEGIN PRIVATE KEY-----\nsynthetic-data\n-----END PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\n…redacted…\n-----END PRIVATE KEY-----",
  ],
  [
    { value: 1n, toString: () => `token=synthetic-value ${"x".repeat(300)}` },
    `token=*** ${"x".repeat(230)}...`,
  ],
])("preserves redacted WS frame output (case %#)", (detail, expected) => {
  logFrame(detail);
  expect(output.mock.calls.map(([line]) => stripVTControlCharacters(line))).toEqual([
    `→ res ✓ health detail=${expected} id=frame`,
  ]);
});
