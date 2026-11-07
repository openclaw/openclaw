import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import { gatewaySuccessReply } from "./agent-via-gateway.test-support.js";

const { callGateway, loadConfig } = vi.hoisted(() => ({
  callGateway: vi.fn(),
  loadConfig: vi.fn(),
}));

// mock-isolation: input validation and dispatch must not load operator config or contact a Gateway.
vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: loadConfig,
  readGatewayDispatchConfigWithShellEnvFallback: loadConfig,
}));
// mock-isolation: the command's config reader must not inspect operator state.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: loadConfig,
  captureRuntimeConfigAsyncReader: () => async () => loadConfig(),
  loadConfig,
}));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
let messageFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
  const dir = tempDirs.make("agent-message-input-");
  messageFile = path.join(dir, "-");
  loadConfig.mockReturnValue({
    agents: { entries: { main: {} } },
    session: { store: path.join(dir, "sessions.json"), mainKey: "main" },
  });
  callGateway.mockResolvedValue(gatewaySuccessReply("ok"));
});
afterEach(() => vi.unstubAllEnvs());

function runInput() {
  return agentCliCommand({ messageFile: "-", sessionKey: "agent:main:stdin" }, runtime);
}

it("dispatches chunked UTF-8 stdin with BOM removal and preserved multiline content", async () => {
  const originalStdin = expectDefined(
    Object.getOwnPropertyDescriptor(process, "stdin"),
    "stdin descriptor",
  );
  const bytes = Buffer.from("\uFEFF First line\n中文 😀\r\nLast line\n");
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: Readable.from([bytes.subarray(0, 17), bytes.subarray(17, 20), bytes.subarray(20)]),
  });
  try {
    await runInput();
    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({ message: " First line\n中文 😀\r\nLast line\n" }),
      }),
    );
  } finally {
    Object.defineProperty(process, "stdin", originalStdin);
  }
});

it.each([
  ["empty", Buffer.from(" \n"), "Message stdin is empty"],
  ["invalid UTF-8", Buffer.from([0xff]), "Message stdin must be valid UTF-8"],
  ["oversized", Buffer.alloc(4 * 1024 * 1024 + 1, "x"), "Message stdin exceeds 4194304 bytes"],
])("rejects %s stdin before dispatch", async (_kind, bytes, error) => {
  const originalStdin = expectDefined(
    Object.getOwnPropertyDescriptor(process, "stdin"),
    "stdin descriptor",
  );
  Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([bytes]) });
  try {
    await expect(runInput()).rejects.toThrow(error);
    expect(callGateway).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "stdin", originalStdin);
  }
});

it("reads an explicitly addressed literal dash file", async () => {
  fs.writeFileSync(messageFile, "literal dash prompt");
  await agentCliCommand({ messageFile, sessionKey: "agent:main:file" }, runtime);
  expect(callGateway).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      params: expect.objectContaining({ message: "literal dash prompt" }),
    }),
  );
});

it("rejects a blank file before dispatch", async () => {
  fs.writeFileSync(messageFile, " \n");
  await expect(
    agentCliCommand({ messageFile, sessionKey: "agent:main:file" }, runtime),
  ).rejects.toThrow(`Message file is empty: ${messageFile}`);
  expect(callGateway).not.toHaveBeenCalled();
});
