// QA OTEL Smoke tests cover QA Lab telemetry evidence.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { createConnection as createNetConnection } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../../src/infra/runtime-worker-url.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { qaOtelSmokeEntrypoint } from "./qa-otel-smoke-entrypoint.test-support.js";
import { testing } from "./qa-otel-smoke-runtime.js";

const runtimeUrl = resolveRuntimeWorkerUrl(qaOtelSmokeEntrypoint);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const collectorId = "00000000-0000-4000-8000-000000000000";

function makeCollectorFixture() {
  const collectorDir = path.join(tempDirs.make("openclaw-qa-otel-collector-"), "collector");
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  });
  const ports = [4318, 45679];
  const stopDockerContainer = vi.fn(async () => {});
  const deps = {
    mkdtemp: async () => {
      mkdirSync(collectorDir);
      return collectorDir;
    },
    randomUUID: () => collectorId,
    reserveLocalPort: async () => ports.shift() ?? 49999,
    spawn: vi.fn(() => child) as never,
    stopDockerContainer,
  };
  return { collectorDir, child, deps, stopDockerContainer };
}

async function expectCloses(promise: Promise<unknown>, label: string) {
  await Promise.race([
    promise,
    delay(1_000, undefined, { ref: false }).then(() => {
      throw new Error(`${label} close timed out`);
    }),
  ]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("qa-otel-smoke receiver bounds", () => {
  function makePassingSmokeAssertionInput(): Parameters<typeof testing.assertSmoke>[0] {
    return {
      bodyText: {
        logs: ["diagnostics-otel: logs exporter enabled"],
      },
      childExitCode: 0,
      disallowedBodyNeedles: ["OTEL-QA-SECRET"],
      logsExporter: "otlp",
      logRecords: [
        {
          body: "diagnostics-otel: logs exporter enabled",
          traceId: "trace",
          spanId: "span",
        },
      ],
      metrics: [{ name: "openclaw.harness.duration_ms" }],
      requests: (["traces", "metrics", "logs"] as const).map((signal) => ({
        path: `/v1/${signal}`,
        signal,
        bytes: 16,
        contentEncoding: undefined,
        status: 200,
        spanCount: signal === "traces" ? 5 : 0,
        metricCount: signal === "metrics" ? 1 : 0,
        logCount: signal === "logs" ? 1 : 0,
      })),
      stdoutLogLines: [],
      stdoutLogRecords: [],
      spans: [
        ...["openclaw.run", "openclaw.harness.run"].map((name) => ({
          name,
          parent: name !== "openclaw.run",
          attributes: { "openclaw.error": "QA OTEL provider stream failed OPENAI_API_KEY=***" },
        })),
        { name: "openclaw.context.assembled", parent: true, attributes: {} },
        { name: "openclaw.message.delivery", parent: true, attributes: {} },
        {
          name: "chat gpt-5.6-luna",
          parent: true,
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "gpt-5.6-luna",
            "openclaw.model": "gpt-5.6-luna",
            "openclaw.provider": "openai",
          },
        },
      ],
    };
  }

  it("rejects duplicate OTEL smoke CLI options", () => {
    const duplicateCases = [
      ["--collector", ["--collector", "local", "--collector", "docker"]],
      ["--logs-exporter", ["--logs-exporter", "otlp", "--logs-exporter", "stdout"]],
      ["--output-dir", ["--output-dir", ".artifacts/one", "--output-dir", ".artifacts/two"]],
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => testing.parseArgs(args), flag).toThrow(`${flag} was provided more than once`);
    }
  });

  it("uses unique default output dirs", () => {
    const firstOutputDir = testing.parseArgs([]).outputDir;
    const secondOutputDir = testing.parseArgs([]).outputDir;

    expect(path.dirname(firstOutputDir)).toBe(path.join(".artifacts", "qa-e2e"));
    expect(path.basename(firstOutputDir)).toMatch(/^otel-smoke-[a-z0-9]+-[a-f0-9]{8}$/u);
    expect(secondOutputDir).not.toBe(firstOutputDir);
    expect(testing.parseArgs(["--output-dir", ".artifacts/custom"]).outputDir).toBe(
      ".artifacts/custom",
    );
  });

  it("ignores inherited OTEL exporter endpoints during direct producer execution", () => {
    const tempRoot = tempDirs.make("openclaw-qa-otel-env-isolation-");
    const result = spawnSync(
      process.execPath,
      [...resolveRuntimeWorkerArgv(runtimeUrl), "--output-dir", tempRoot],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:2/v1/traces",
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:3/v1/metrics",
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4/v1/logs",
        },
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("qa-otel-smoke: passed");
  });

  it("rejects identity OTLP bodies above the decoded byte ceiling", () => {
    expect(() => testing.decodeRequestBody(Buffer.alloc(65), undefined, 64)).toThrow(
      "OTLP request body exceeded 64 bytes: 65 bytes",
    );
  });

  it("rejects gzip OTLP bodies above the decoded byte ceiling", () => {
    const compressed = gzipSync(Buffer.alloc(256, "a"));

    expect(() => testing.decodeRequestBody(compressed, "gzip", 64)).toThrow(
      "decoded OTLP request body exceeded 64 bytes",
    );
  });

  it("returns a bounded failure for malformed local OTLP protobuf", async () => {
    const receiver = testing.startLocalOtlpReceiver(["OTEL-QA-SECRET"]);
    const port = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: Buffer.concat([Buffer.from([0x0a]), Buffer.from("OTEL-QA-SECRET")]),
      });
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(text).toContain("truncated protobuf");
      expect(receiver.capturedRequests).toEqual([
        {
          path: "/v1/traces",
          signal: "traces",
          bytes: 15,
          contentEncoding: undefined,
          status: 400,
          spanCount: 0,
          metricCount: 0,
          logCount: 0,
        },
      ]);
      expect(receiver.capturedBodyText.traces).toEqual([
        "[detected leak needle] OTEL-QA-SECRET",
        "\nOTEL-QA-SECRET",
      ]);
    } finally {
      await receiver.close();
    }
  });

  it("closes active local OTLP receiver sockets during cleanup", async () => {
    const receiver = testing.startLocalOtlpReceiver();
    const port = await receiver.listen();
    const socket = createNetConnection(port, "127.0.0.1");
    const socketClosed = new Promise<void>((resolve) => {
      socket.once("close", resolve);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        [
          "POST /v1/traces HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/x-protobuf",
          "Content-Length: 1048576",
          "",
          "x",
        ].join("\r\n"),
      );

      await expectCloses(receiver.close(), "receiver");
      await expectCloses(socketClosed, "socket");
    } finally {
      socket.destroy();
      await receiver.close().catch(() => {});
    }
  });

  it("still fails when OTLP log payload text leaks scenario content", () => {
    const input = makePassingSmokeAssertionInput();
    input.bodyText = {
      logs: ["diagnostics-otel: log payload contains OTEL-QA-SECRET"],
    };

    const assertion = testing.assertSmoke(input);

    expect(assertion.passed).toBe(false);
    expect(assertion.failures).toContain("OTLP logs payload leaked content: OTEL-QA-SECRET");
    expect(assertion.leakContexts.logs?.[0]).toContain("[needle]");
  });

  it("still fails when stdout diagnostic log payload text leaks scenario content", () => {
    const input = makePassingSmokeAssertionInput();
    input.logsExporter = "stdout";
    input.bodyText = {};
    input.logRecords = [];
    input.requests = input.requests.filter((request) => request.signal !== "logs");
    input.stdoutLogRecords = [
      {
        ts: "2026-06-18T00:00:00.000Z",
        signal: "openclaw.diagnostic.log",
        "service.name": "openclaw-qa-lab-otel-smoke",
        severityText: "INFO",
        severityNumber: 9,
        body: "log",
        attributes: {},
      },
    ];
    input.stdoutLogLines = [
      JSON.stringify({
        ...input.stdoutLogRecords[0],
        body: "diagnostics-otel: log payload contains OTEL-QA-SECRET",
      }),
    ];

    const assertion = testing.assertSmoke(input);

    expect(assertion.passed).toBe(false);
    expect(assertion.failures).toContain(
      "stdout diagnostic log payload leaked content: OTEL-QA-SECRET",
    );
    expect(assertion.leakContexts.logs?.[0]).toContain("[needle]");
  });

  it("preserves leak markers even when later body text is truncated", () => {
    const captured: { traces?: string[] } = {};

    testing.appendCapturedBodyText(
      captured,
      "traces",
      Buffer.from(`prefix OTEL-QA-SECRET ${"a".repeat(20)}`),
      16,
      ["OTEL-QA-SECRET"],
    );
    testing.appendCapturedBodyText(captured, "traces", Buffer.from("b".repeat(128)), 16, [
      "OTEL-QA-SECRET",
    ]);

    expect(captured.traces?.join("\n")).toContain("OTEL-QA-SECRET");
    expect(captured.traces?.join("\n")).toContain("[captured body text truncated");
  });

  it("disables unused Docker collector telemetry instead of binding a host port", async () => {
    const { deps, stopDockerContainer } = makeCollectorFixture();
    let writtenConfig = "";
    const removePath = vi.fn(async () => {});

    const collector = await testing.startDockerOtelCollector(4317, {
      ...deps,
      mkdtemp: async () => "/tmp/openclaw-otel-collector-test",
      platform: "linux",
      rm: removePath as never,
      waitForLocalPort: async () => {},
      writeFile: async (_path, config) => {
        writtenConfig =
          typeof config === "string" ? config : Buffer.from(config as Uint8Array).toString("utf8");
      },
    });

    expect(writtenConfig).toContain("endpoint: 127.0.0.1:4318");
    expect(writtenConfig).toContain("telemetry:");
    expect(writtenConfig).toContain("level: none");
    expect(writtenConfig).not.toContain("address:");

    await collector.close();
    expect(stopDockerContainer).toHaveBeenCalledWith(`openclaw-otel-smoke-${collectorId}`);
    expect(removePath).toHaveBeenCalledWith("/tmp/openclaw-otel-collector-test", {
      force: true,
      recursive: true,
    });
  });

  it("cleans Docker collector containers and temp config after readiness failures", async () => {
    const { collectorDir, deps, stopDockerContainer } = makeCollectorFixture();
    await expect(
      testing.startDockerOtelCollector(4317, {
        ...deps,
        waitForLocalPort: async () => {
          throw new Error("collector never became ready");
        },
      }),
    ).rejects.toThrow("collector never became ready");

    expect(stopDockerContainer).toHaveBeenCalledWith(`openclaw-otel-smoke-${collectorId}`);
    expect(existsSync(collectorDir)).toBe(false);
  });
  it("reports bounded Docker collector output when readiness exits", async () => {
    const { child, deps } = makeCollectorFixture();
    let thrown: unknown;
    await testing
      .startDockerOtelCollector(4317, {
        ...deps,
        waitForLocalPort: async (_port, _timeout, readFailure) => {
          child.stdout.emit("data", "DO_NOT_DUMP_COLLECTOR_PREFIX\n");
          child.stderr.emit("data", Buffer.alloc(64 * 1024, "x"));
          child.stderr.emit("data", "\nCOLLECTOR_TAIL_MARKER\n");
          child.emit("close", 1);
          await delay(0);
          throw new Error(readFailure());
        },
      })
      .catch((error: unknown) => {
        thrown = error;
      });

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("COLLECTOR_TAIL_MARKER");
    expect(message).not.toContain("DO_NOT_DUMP_COLLECTOR_PREFIX");
    expect(message.length).toBeLessThan(24 * 1024);
  });
});
