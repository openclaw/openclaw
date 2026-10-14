import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
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
          if (frame.method === "connect") {
            sendMinimalGatewayResponse(
              socket,
              frame.id,
              buildMinimalGatewayHelloOkPayload({ methods: ["logs.tail"] }),
            );
          } else if (!options.failure) {
            sendMinimalGatewayResponse(socket, frame.id, {
              file: "selected-gateway.log",
              cursor: 1,
              lines: ["selected local log"],
            });
          }
        });
      });
      await once(server, "listening");
      const port = String((server.address() as AddressInfo).port);
      const stdout: string[] = [];
      const stderr: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
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
  await runRegisteredCli({ register: registerLogsCli, argv: ["logs", ...argv] });
}

describe("logs local port selection", () => {
  it.each(["config"] as const)(
    "tails the selected local port instead of validating the %s default URL",
    async (source) => {
      await withLogsGateway({ source }, async ({ port, requests, stdout }) => {
        await runLogs(["--port", port, "--json", "--timeout", "1500"]);
        expect(requests).toEqual(["connect", "logs.tail"]);
        expect(stdout.join("")).toContain("selected local log");
      });
    },
  );

  it.each(["--max-bytes"])(
    "rejects an explicitly empty numeric %s before contacting Gateway",
    async (flag) => {
      await withLogsGateway({}, async ({ port, requests }) => {
        await expect(
          runLogs(["--port", port, flag, "", "--json", "--timeout", "1500"]),
        ).rejects.toThrow(`${flag} must be a positive integer.`);
        expect(requests).toEqual([]);
      });
    },
  );

  it.each([{ failure: "timeout" as const, error: /timeout|timed out/ }])(
    "uses the failure reason as the JSON summary after a post-hello $failure",
    async ({ failure, error }) => {
      await withLogsGateway({ failure }, async ({ port, requests, stdout, stderr }) => {
        await expect(
          runLogs([
            "--url",
            `ws://127.0.0.1:${port}`,
            "--token",
            "fixture-token",
            "--json",
            "--timeout",
            "1500",
          ]),
        ).rejects.toBeInstanceOf(ExitError);
        expect(requests).toEqual(["connect", "logs.tail"]);
        expect(stdout.join("")).toBe("");
        expect(JSON.parse(stderr.join(""))).toMatchObject({
          type: "error",
          message: expect.stringMatching(error),
          error: expect.stringMatching(error),
          details: { url: `ws://127.0.0.1:${port}` },
        });
      });
    },
  );

  it.each(["malformed"] as const)("honors an explicit URL with unusable %s", async (source) => {
    await withLogsGateway({ source }, async ({ port, requests, stdout, stderr }) => {
      await runLogs([
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        "fixture-token",
        "--json",
        "--timeout",
        "1500",
      ]);
      expect(requests).toEqual(["connect", "logs.tail"]);
      expect(stdout.join("")).toContain("selected local log");
      if (source === "malformed") {
        expect(stderr.join("")).toContain("openclaw doctor --fix");
      }
    });
  });

  it.each(["config"] as const)(
    "still rejects an unsafe %s target without an override",
    async (source) => {
      await withLogsGateway({ source }, async ({ requests }) => {
        await expect(runLogs(["--json"])).rejects.toThrow(
          "uses plaintext ws:// to a non-loopback address",
        );
        expect(requests).toEqual([]);
      });
    },
  );

  it.each([
    { args: ["--port", "65536"], message: "--port must be an integer between 1 and 65535." },
    {
      args: ["--port", "19083", "--url", "ws://127.0.0.1:19083"],
      message: "Use either --url or --port, not both.",
    },
  ])("keeps target validation for $args", async ({ args, message }) => {
    await withLogsGateway({}, async ({ requests }) => {
      await expect(runLogs(args)).rejects.toThrow(message);
      expect(requests).toEqual([]);
    });
  });
});
