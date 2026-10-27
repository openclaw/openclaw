import { Console } from "node:console";
import { once } from "node:events";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
} from "../gateway/minimal-gateway.test-helpers.js";
import { enableConsoleCapture } from "../logging/console.js";
import { applyLoggingConfig, setLoggerOverride } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { loggingState } from "../logging/state.js";
import {
  captureConsoleSnapshot,
  restoreConsoleSnapshot,
} from "../logging/test-helpers/console-snapshot.js";
import type { ConsoleStyle } from "../logging/types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { expectText } from "../test-utils/text-assertions.js";
import { checkGatewayHealth } from "./doctor-gateway-health.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("Doctor Gateway close note output", { concurrent: false }, () => {
  let server: WebSocketServer | undefined;
  let portClaim: TestPortClaim | undefined;
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let cfg: OpenClawConfig;
  let closeReason = "";
  let testLogging = { ...loggingState };

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "doctor-close-output",
      env: {
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_SUPPRESS_NOTES: undefined,
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      },
    });
    portClaim = await acquireTestPortBlock({ offsets: [0] });
    server = new WebSocketServer({ host: "127.0.0.1", port: portClaim.port });
    server.on("connection", (ws) => {
      sendMinimalGatewayConnectChallenge(ws);
      ws.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (frame.method === "connect") {
          ws.close(1011, closeReason);
        }
      });
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Doctor test Gateway did not bind a loopback port");
    }
    cfg = {
      gateway: {
        mode: "remote",
        remote: { url: `ws://127.0.0.1:${address.port}`, token: "doctor-test-token" },
      },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
  });

  beforeEach(() => {
    testLogging = { ...loggingState };
  });
  afterEach(() => {
    Object.assign(loggingState, testLogging);
    resetSecretRedactionRegistryForTest();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (server) {
        await closeMinimalGatewayServer(server);
      }
    } finally {
      await portClaim?.release();
      await state?.cleanup();
    }
  });

  async function captureCloseNote(reason: string): Promise<string> {
    closeReason = reason;
    const runtime = createTestRuntime();
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let output: string;
    try {
      const result = await checkGatewayHealth({ runtime, cfg });
      output = stdout.mock.calls
        .map(([chunk]) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")))
        .join("");
      expect(result).toMatchObject({ healthOk: false, authenticated: false });
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
    const displayed = stripAnsi(output);
    expect(displayed).toContain("Gateway connect failed:");
    expect(displayed).toContain("gateway closed (1011):");
    return displayed;
  }

  async function captureCloseConsole(reason: string, style: ConsoleStyle) {
    const previousConsole = captureConsoleSnapshot();
    const previousLogging = { ...loggingState };
    const writes: string[] = [];
    const stderr = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writes.push(chunk.toString("utf8"));
        callback();
      },
    });
    const realConsole = new Console({ stdout: process.stdout, stderr, colorMode: false });
    const previousListeners = [process.stdout, process.stderr].map((stream) => ({
      stream,
      listeners: new Set(stream.listeners("error")),
    }));
    let releaseCaptureListeners = () => {};
    try {
      // Use Node's real error sink; Vitest's console interception is outside this capture.
      restoreConsoleSnapshot(realConsole);
      Object.assign(loggingState, {
        consolePatched: false,
        rawConsole: null,
        forceConsoleToStderr: false,
        consoleTimestampPrefix: false,
      });
      setLoggerOverride({ level: "silent", consoleLevel: "error", consoleStyle: style });
      enableConsoleCapture();
      const captureListeners = previousListeners.map(({ stream, listeners }) => ({
        stream,
        added: stream.listeners("error").filter((listener) => !listeners.has(listener)),
      }));
      releaseCaptureListeners = () => {
        for (const { stream, added } of captureListeners) {
          for (const listener of added) {
            stream.removeListener("error", listener);
          }
        }
      };
      const note = await captureCloseNote(reason);
      return { note, stderr: writes.join("") };
    } finally {
      releaseCaptureListeners();
      restoreConsoleSnapshot(previousConsole);
      Object.assign(loggingState, previousLogging);
      stderr.end();
      await finished(stderr, { cleanup: true });
    }
  }

  it("keeps built-in masking with custom patterns in Doctor notes and Gateway stderr", async () => {
    applyLoggingConfig({ redactPatterns: ["deploymentMask9X"] });
    const output = await captureCloseConsole(
      "remote password=mockPass7X deploymentMask9X visible",
      "pretty",
    );
    expectText(output.stderr, ["gateway connect failed:", "gateway closed (1011):"]);
    for (const text of [stripAnsi(output.stderr), output.note]) {
      expectText(text, ["remote", "visible", "***"], ["deploymentMask9X", "mockPass7X"]);
    }
  });

  it("masks configured path values in the companion Gateway connection note", async () => {
    applyLoggingConfig({ redactPatterns: ["doctor-close-output"] });
    const output = await captureCloseConsole("ordinary close", "pretty");
    expectText(
      output.note,
      ["ordinary close", "Gateway connection", "Config:", "doctor…tput"],
      ["doctor-close-output"],
    );
  });

  it.each([
    { style: "pretty", shape: "plain", value: "proofSecr9X" },
    { style: "compact", shape: "plain", value: "proofSecr9X" },
    { style: "pretty", shape: "ANSI", value: "proofSe\u001b[31mcr9X" },
    { style: "compact", shape: "ANSI", value: "proofSe\u001b[31mcr9X" },
    { style: "pretty", shape: "NUL", value: "proofSe\u0000cr9X" },
    { style: "compact", shape: "NUL", value: "proofSe\u0000cr9X" },
    { style: "json", shape: "ANSI", value: "proofSe\u001b[31mcr9X" },
  ] as const)("masks $shape in actual $style Gateway stderr", async ({ style, value }) => {
    registerSecretValueForRedaction("proofSecr9X");
    const output = await captureCloseConsole(`remote ${value} visible`, style);
    expectText(output.note, ["***"], ["proofSecr9X"]);
    expectText(output.stderr, ["gateway connect failed:", "gateway closed (1011):"], ["\u0000"]);
    if (style === "json") {
      const records: unknown[] = output.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("remote *** visible"),
        }),
      );
    }
    // NUL is not an ANSI escape. Normalize controls as well to assess visible text.
    const displayed = sanitizeTerminalText(stripAnsi(output.stderr));
    expectText(displayed, ["remote", "visible", "***"], ["proofSecr9X"]);
  });

  it.each([
    ...["\n", "\u2028", "\u2029"].map((separator) => ({
      registered: "lineA9\nlineB7",
      reason: `lineA9${separator}lineB7 omitted detail`,
      forbidden: ["lineA9", "lineB7"],
    })),
    { registered: "joined secret", reason: "joined  secret visible", forbidden: ["joined secret"] },
    {
      registered: "part one\ntwo",
      reason: "part  one\u2028two omitted detail",
      forbidden: ["part one", "two"],
    },
  ])(
    "masks registered $reason through the real note stream",
    async ({ registered, reason, forbidden }) => {
      registerSecretValueForRedaction(registered);
      const output = await captureCloseNote(`remote ${reason}`);
      expectText(output, ["remote", "***"], forbidden);
    },
  );

  it("preserves ordinary close context and terminal control safety", async () => {
    const output = await captureCloseNote("ordinary\r\t\u001b[31mshutdown\nignored detail");
    expectText(output, ["ordinary\\r\\tshutdown"], ["ignored detail", "\r", "\t"]);
  });
});
