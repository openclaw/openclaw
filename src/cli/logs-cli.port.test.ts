import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerLogsCli } from "./logs-cli.js";

afterEach(() => vi.restoreAllMocks());

async function withLogsGateway(
  options: {
    source?: "config" | "malformed";
    failure?: "timeout";
  },
  run: (fixture: {
    port: string;
    requests: string[];
    stdout: string[];
    stderr: string[];
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      label: "logs-port",
      env: {
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined,
      },
    },
    async (state) => {
      await state.writeConfig({
        gateway: {
          mode: options.source === "config" ? "remote" : "local",
          auth: { mode: "none" },
          ...(options.source === "config" ? { remote: { url: "ws://remote.example:19001" } } : {}),
        },
      });
      if (options.source === "malformed") {
        await fs.writeFile(state.configPath, "{ gateway:");
      }
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const requests: string[] = [];
      server.on("connection", (socket) => {
        sendMinimalGatewayConnectChallenge(socket);
        socket.on("message", (data) => {
          const frame = parseMinimalGatewayRequestFrame(data);
          if (!frame.id || !frame.method) {
            return;
          }
          requests.push(frame.method);
          if (frame.method === "connect" || !options.failure) {
            const payload =
              frame.method === "connect"
                ? buildMinimalGatewayHelloOkPayload({ methods: ["logs.tail"] })
                : { file: "selected-gateway.log", cursor: 1, lines: ["selected local log"] };
            sendMinimalGatewayResponse(socket, frame.id, payload);
          }
        });
      });
      await once(server, "listening");
      const port = String((server.address() as AddressInfo).port);
      const stdout: string[] = [];
      const stderr: string[] = [];
      for (const [stream, chunks] of [
        [process.stdout, stdout],
        [process.stderr, stderr],
      ] as const) {
        vi.spyOn(stream, "write").mockImplementation((chunk) => {
          chunks.push(String(chunk));
          return true;
        });
      }
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new ExitError(code);
      });
      try {
        await run({ port, requests, stdout, stderr });
      } finally {
        await closeMinimalGatewayServer(server);
      }
    },
  );
}

async function runLogs(argv: string[]) {
  await runRegisteredCli({
    register: registerLogsCli,
    argv: ["logs", ...argv, "--json", "--timeout", "1500"],
  });
}
const gatewayUrl = (port: string) => `ws://127.0.0.1:${port}`;
const explicitTarget = (port: string) => ["--url", gatewayUrl(port), "--token", "fixture-token"];

it.each(["config", "malformed"] as const)(
  "honors an explicit target with %s config",
  async (source) => {
    await withLogsGateway({ source }, async ({ port, requests, stdout, stderr }) => {
      await runLogs(source === "config" ? ["--port", port] : explicitTarget(port));
      expect(requests).toEqual(["connect", "logs.tail"]);
      expect(stdout.join("")).toContain("selected local log");
      if (source === "malformed") {
        expect(stderr.join("")).toContain("openclaw doctor --fix");
      }
    });
  },
);

it("uses the failure reason as the JSON summary after a post-hello timeout", async () => {
  await withLogsGateway({ failure: "timeout" }, async ({ port, requests, stdout, stderr }) => {
    await expect(runLogs(explicitTarget(port))).rejects.toBeInstanceOf(ExitError);
    expect(requests).toEqual(["connect", "logs.tail"]);
    expect(stdout.join("")).toBe("");
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      type: "error",
      message: expect.stringMatching(/timeout|timed out/),
      error: expect.stringMatching(/timeout|timed out/),
      details: { url: gatewayUrl(port) },
    });
  });
});

it.each([
  [undefined, ["--port", "$port", "--max-bytes", ""], "--max-bytes must be a positive integer."],
  ["config", [], "uses plaintext ws:// to a non-loopback address"],
  [undefined, ["--port", "65536"], "--port must be an integer between 1 and 65535."],
  [
    undefined,
    ["--port", "19083", "--url", "ws://127.0.0.1:19083"],
    "Use either --url or --port, not both.",
  ],
] as const)("rejects config=%s args=%j before connecting", async (source, args, message) => {
  await withLogsGateway({ source }, async ({ port, requests }) => {
    await expect(runLogs(args.map((arg) => (arg === "$port" ? port : arg)))).rejects.toThrow(
      message,
    );
    expect(requests).toEqual([]);
  });
});
