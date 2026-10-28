import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
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
    randomUUID: (): typeof collectorId => collectorId,
    reserveLocalPort: async () => ports.shift() ?? 49999,
    spawn: vi.fn(() => child) as never,
    stopDockerContainer,
  };
  return { collectorDir, child, deps, stopDockerContainer };
}

describe("qa-otel-smoke receiver bounds", () => {
  it("rejects duplicate OTEL smoke CLI options", () => {
    expect(() => testing.parseArgs(["--collector", "local", "--collector", "docker"])).toThrow(
      "--collector was provided more than once",
    );
  });

  it("uses unique default output dirs", () => {
    const firstOutputDir = testing.parseArgs([]).outputDir;
    const secondOutputDir = testing.parseArgs([]).outputDir;

    expect(path.dirname(firstOutputDir)).toBe(path.join(".artifacts", "qa-e2e"));
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
  });

  it.each([
    [undefined, Buffer.alloc(65), "OTLP request body exceeded 64 bytes: 65 bytes"],
    ["gzip", gzipSync(Buffer.alloc(256, "a")), "decoded OTLP request body exceeded 64 bytes"],
  ] as const)("rejects %s OTLP bodies above the decoded byte ceiling", (encoding, body, error) => {
    expect(() => testing.decodeRequestBody(body, encoding, 64)).toThrow(error);
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
      expect(receiver.capturedRequests).toMatchObject([{ status: 400 }]);
      expect(receiver.capturedBodyText.traces).toEqual([
        "[detected leak needle] OTEL-QA-SECRET",
        "\nOTEL-QA-SECRET",
      ]);
    } finally {
      await receiver.close();
    }
  });

  it.each([
    ["otlp", "OTLP logs"],
    ["stdout", "stdout diagnostic log"],
  ] as const)("still fails when %s log payload text leaks scenario content", (exporter, label) => {
    const log = "diagnostics-otel: log payload contains OTEL-QA-SECRET";
    expect(
      testing.assertSmoke({
        childExitCode: 0,
        disallowedBodyNeedles: ["OTEL-QA-SECRET"],
        logsExporter: exporter,
        bodyText: exporter === "otlp" ? { logs: [log] } : {},
        stdoutLogLines: exporter === "stdout" ? [log] : [],
        logRecords: [],
        metrics: [],
        requests: [],
        stdoutLogRecords: [],
        spans: [],
      }),
    ).toMatchObject({
      failures: expect.arrayContaining([`${label} payload leaked content: OTEL-QA-SECRET`]),
      leakContexts: { logs: [expect.stringContaining("[needle]")] },
    });
  });

  it("preserves leak markers even when later body text is truncated", () => {
    const captured: { traces?: string[] } = {};
    const append = (body: string) =>
      testing.appendCapturedBodyText(captured, "traces", Buffer.from(body), 16, ["OTEL-QA-SECRET"]);
    append(`prefix OTEL-QA-SECRET ${"a".repeat(20)}`);
    append("b".repeat(128));
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

    expect(writtenConfig).toContain("level: none");

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
    let message = "";
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
        expect(error).toBeInstanceOf(Error);
        message = error instanceof Error ? error.message : String(error);
      });
    expect(message).toContain("COLLECTOR_TAIL_MARKER");
    expect(message).not.toContain("DO_NOT_DUMP_COLLECTOR_PREFIX");
    expect(message.length).toBeLessThan(24 * 1024);
  });
});
