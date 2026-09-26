import { Console } from "node:console";
import { once } from "node:events";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { checkGatewayHealth } from "./doctor-gateway-health.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("Doctor Gateway close note output", { concurrent: false }, () => {
  let server: WebSocketServer | undefined;
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let cfg: OpenClawConfig;
  let closeReason = "";
  const requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[] = [];

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
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws) => {
      sendMinimalGatewayConnectChallenge(ws);
      ws.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        requests.push(frame);
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

  afterEach(() => {
    resetSecretRedactionRegistryForTest();
    vi.restoreAllMocks();
    requests.length = 0;
  });

  afterAll(async () => {
    try {
      if (server) {
        await closeMinimalGatewayServer(server);
      }
    } finally {
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
      expect(requests.map((request) => request.method)).toEqual(["connect"]);
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
    const previousLogging = { ...loggingState };
    try {
      applyLoggingConfig({ redactPatterns: ["deploymentMask9X"] });
      const output = await captureCloseConsole(
        "remote password=mockPass7X deploymentMask9X visible",
        "pretty",
      );
      const stderr = stripAnsi(output.stderr);
      expect(stderr).toContain("gateway connect failed:");
      expect(stderr).toContain("gateway closed (1011):");
      expect(stderr).toContain("remote");
      expect(stderr).toContain("visible");
      expect(stderr).not.toContain("deploymentMask9X");
      expect(stderr).not.toContain("mockPass7X");
      expect(stderr).toContain("***");
      expect(output.note).toContain("remote");
      expect(output.note).toContain("visible");
      expect(output.note).not.toContain("deploymentMask9X");
      expect(output.note).toContain("***");
      expect(output.note).not.toContain("mockPass7X");
    } finally {
      Object.assign(loggingState, previousLogging);
    }
  });

  it("masks configured path values in the companion Gateway connection note", async () => {
    const previousLogging = { ...loggingState };
    try {
      applyLoggingConfig({ redactPatterns: ["doctor-close-output"] });
      const output = await captureCloseConsole("ordinary close", "pretty");
      expect(output.note).toContain("ordinary close");
      expect(output.note).toContain("Gateway connection");
      expect(output.note).toContain("Config:");
      expect(output.note).not.toContain("doctor-close-output");
      expect(output.note).toContain("doctor…tput");
    } finally {
      Object.assign(loggingState, previousLogging);
    }
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
    expect(output.note).not.toContain("proofSecr9X");
    expect(output.note).toContain("***");
    expect(output.stderr).toContain("gateway connect failed:");
    expect(output.stderr).toContain("gateway closed (1011):");
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
    expect(displayed).toContain("remote");
    expect(displayed).toContain("visible");
    expect(displayed).not.toContain("proofSecr9X");
    expect(output.stderr).not.toContain("\u0000");
    expect(displayed).toContain("***");
  });

  it.each([
    {
      name: "registered plain value",
      registered: "proofSecr9X",
      reason: "remote proofSecr9X visible",
      forbidden: ["proofSecr9X"],
    },
    {
      name: "registered value joined by ANSI removal",
      registered: "proofSecr9X",
      reason: "remote proofSe\u001b[31mcr9X visible",
      forbidden: ["proofSecr9X"],
    },
    {
      name: "registered value joined by control removal",
      registered: "proofSecr9X",
      reason: "remote proofSe\u0000cr9X visible",
      forbidden: ["proofSecr9X"],
    },
    {
      name: "registered multiline value",
      registered: "lineA9\nlineB7",
      reason: "remote lineA9\nlineB7 omitted detail",
      forbidden: ["lineA9", "lineB7"],
    },
    {
      name: "registered value joined by note whitespace",
      registered: "joined secret",
      reason: "remote joined  secret visible",
      forbidden: ["joined secret"],
    },
    {
      name: "registered multiline value with a Unicode line separator",
      registered: "lineA9\nlineB7",
      reason: "remote lineA9\u2028lineB7 omitted detail",
      forbidden: ["lineA9", "lineB7"],
    },
    {
      name: "registered multiline value with a Unicode paragraph separator",
      registered: "lineA9\nlineB7",
      reason: "remote lineA9\u2029lineB7 omitted detail",
      forbidden: ["lineA9", "lineB7"],
    },
    {
      name: "registered value reconstructed by both note transformations",
      registered: "part one\ntwo",
      reason: "remote part  one\u2028two omitted detail",
      forbidden: ["part one", "two"],
    },
    {
      name: "credential assignment",
      registered: undefined,
      reason: "remote password=mockPass7X visible",
      forbidden: ["mockPass7X"],
    },
  ])("masks $name through the real note stream", async ({ registered, reason, forbidden }) => {
    if (registered) {
      registerSecretValueForRedaction(registered);
    }
    const output = await captureCloseNote(reason);
    expect(output).toContain("remote");
    for (const value of forbidden) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain("***");
  });

  it("preserves ordinary close context and terminal control safety", async () => {
    const output = await captureCloseNote("ordinary\r\t\u001b[31mshutdown\nignored detail");
    expect(output).toContain("ordinary\\r\\tshutdown");
    expect(output).not.toContain("ignored detail");
    expect(output).not.toContain("\r");
    expect(output).not.toContain("\t");
  });
});
