import { channel } from "node:diagnostics_channel";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    isEnabled: () => true,
    info: output,
    warn: output,
  }),
}));

beforeEach(() => {
  setVerbose(true);
  setGatewayWsLogStyle("full");
  output.mockClear();
});

afterEach(() => {
  setVerbose(false);
  setGatewayWsLogStyle("auto");
});

function logFrame(detail: unknown): void {
  logWs("out", "res", { method: "health", ok: true, detail, id: "frame" });
}

test("compiles the default patterns only once across repeated WS frames", () => {
  const compile = vi.mocked(compileConfigRegex);
  const initialCalls = compile.mock.calls.length;
  logFrame("token=synthetic-value");
  const firstFrameCalls = compile.mock.calls.length;
  expect(firstFrameCalls).toBeGreaterThan(initialCalls);
  for (let index = 0; index < 20; index += 1) {
    logFrame("token=synthetic-value");
  }
  expect(compile.mock.calls.length).toBe(firstFrameCalls);
});

test("skips the default pattern walk for WS frames without candidate substrings", () => {
  const source = channel("openclaw.redaction");
  const measurements: unknown[] = [];
  const listener = (message: unknown) => measurements.push(message);
  source.subscribe(listener);
  try {
    logFrame("token=synthetic-value");
    expect(measurements).toContainEqual(expect.objectContaining({ operation: "text" }));
    measurements.length = 0;
    for (let index = 0; index < 20; index += 1) {
      logFrame("ordinary response completed");
    }
    expect(measurements).toHaveLength(0);
  } finally {
    source.unsubscribe(listener);
  }
});

test.each([
  ["ordinary response completed", "ordinary response completed"],
  ["sk-abcdefghijklmnopqrstuvwxyz123456", "sk-abc…3456"],
  ["prefixSG.abcdefghijk.abcdefghijk", "prefixSG.abc…hijk"],
  [{ token: "sk-abcdefghijklmnopqrstuvwxyz123456" }, '{"token":"sk-abc…3456"}'],
  [new Error("password=synthetic-value"), "Error: password=***"],
  [{ message: "token=synthetic-value", code: "E1" }, "token=*** code=E1"],
  ["body: to%6ben=synthetic-value&mode=read", "body: to%6ben=***&mode=read"],
  ["to%6ben+=synthetic-value&mode=read", "to%6ben+=***&mode=read"],
  ["to%6ben\u3164=synthetic-value&mode=read", "to%6ben\u3164=***&mode=read"],
  ["pass+=synthetic-value&mode=read", "pass+=***&mode=read"],
  ["sig\u3164=synthetic-value&mode=read", "sig\u3164=***&mode=read"],
  ["https://example.test/?session+=synthetic-value", "https://example.test/?session+=***"],
  [
    'Authorization: Digest username="user", response="synthetic-value"',
    "Authorization: Digest ***",
  ],
  [
    "-----BEGIN PRIVATE KEY-----\nsynthetic-data\n-----END PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\n…redacted…\n-----END PRIVATE KEY-----",
  ],
])("preserves redacted WS frame output for %j", (detail, expected) => {
  logFrame(detail);
  expect(output.mock.calls.map(([line]) => stripVTControlCharacters(line))).toEqual([
    `→ res ✓ health detail=${expected} id=frame`,
  ]);
});
