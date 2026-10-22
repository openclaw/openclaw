import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installPackageSpec } from "../../scripts/lib/cross-os-release-checks/install.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";
import { makeReleaseLane } from "./release-lane.test-support.ts";

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("../../scripts/lib/cross-os-release-checks/process.ts", () => mocks);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => mocks.runCommand.mockReset());

function fixture() {
  const rootDir = tempDirs.make("cross-os-npm-diagnostics-");
  const logsDir = join(rootDir, ".npm", "_logs");
  mkdirSync(logsDir, { recursive: true });
  const params = {
    lane: makeReleaseLane(rootDir, { prefixDir: join(rootDir, "prefix") }),
    env: { npm_config_logs_dir: logsDir },
    packageSpec: "openclaw@2026.7.1-2",
    logPath: join(rootDir, "install.log"),
  };
  const writeLog = (content: string, file = "install-debug-0.log") =>
    writeFileSync(join(logsDir, file), content);
  return {
    ...params,
    logsDir,
    readLog: (file = params.logPath) => readFileSync(file, "utf8"),
    writeLog,
    install(action: () => void = () => {}, logPath = params.logPath) {
      mocks.runCommand.mockImplementationOnce(async () => {
        action();
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      return installPackageSpec({ ...params, logPath });
    },
  };
}

function diagnostics(log: string) {
  const record = log.match(/^\[release-checks\] npm-diagnostics (.+)$/mu)?.[1];
  expect(record, "phase must retain npm diagnostics").toBeDefined();
  return JSON.parse(record!);
}

const secret = "credential-sentinel";
const installLog = [
  `0 verbose title npm install https://user:${secret}@registry.test/package.tgz`,
  `1 http fetch GET 200 https://registry.test/?token=${secret} 123ms (cache miss)`,
  "2 http cache https://registry.test/public 5ms (cache hit)",
  "6 verbose exit 0",
  "7 http fetch GET 200 https://registry.test/public 999999999999999999ms",
  "8 http fetch GET 200 https://registry.test/public -1ms",
  `9 error code ${secret}`,
  `10 verbose title npm ${secret}`,
].join("\n");
const failureLog = `0 error code ETIMEDOUT\n1 error password=${secret}\n2 verbose exit 1\n`;
const fetch = { count: 2, cacheHits: 1, cacheMisses: 1, durationMs: 128, maxDurationMs: 123 };
it.each([
  ["success", installLog, { command: "install", exitCode: 0, fetch }],
  ["failed", failureLog, { errorCodes: ["ETIMEDOUT"], exitCode: 1 }],
  ["unavailable", null, null],
] as const)("retains safe npm diagnostics on %s", async (scenario, log, expected) => {
  const params = fixture();
  if (scenario === "unavailable") {
    params.env.npm_config_logs_dir = join(params.lane.rootDir, "not-a-directory");
    writeFileSync(params.env.npm_config_logs_dir, "not a directory");
  }
  const failure = scenario === "failed" ? new Error("install failed") : null;
  const result = params.install(() => {
    if (log !== null) {
      params.writeLog(log);
    }
    if (failure) {
      throw failure;
    }
  });
  if (failure) {
    await expect(result).rejects.toBe(failure);
  } else {
    await expect(result).resolves.toBeUndefined();
  }
  expect(diagnostics(params.readLog()).logs).toMatchObject(expected ? [expected] : []);
  for (const forbidden of [secret, "registry.test", params.logsDir]) {
    expect(params.readLog()).not.toContain(forbidden);
  }
});

it("ignores stale process logs and bounds the retained tail and process count", async () => {
  const params = fixture();
  params.writeLog("0 error code EACCES\n", "stale-debug-0.log");
  await params.install(() => {
    for (let index = 0; index < 12; index++) {
      params.writeLog(
        `0 error code ENOSPC\n${"credential-sentinel\n".repeat(20_000)}1 error code EPERM\n`,
        `2026-08-29T00_00_${String(index).padStart(2, "0")}_000Z-debug-0.log`,
      );
    }
  });
  expect(diagnostics(params.readLog())).toMatchObject({
    truncated: true,
    logs: Array.from({ length: 8 }, () => ({ truncated: true, errorCodes: ["EPERM"] })),
  });
  expect(Buffer.byteLength(params.readLog())).toBeLessThan(16 * 1024);
});

it("attributes only newly appended and rotated log records to the next phase", async () => {
  const params = fixture();
  const npmLogPath = join(params.logsDir, "install-debug-0.log");
  await params.install(() => params.writeLog("0 error code EPERM\n"));
  const nextLogPath = join(params.lane.rootDir, "next-install.log");
  await params.install(() => {
    appendFileSync(npmLogPath, "1 error code ETIMEDOUT\n");
    writeFileSync(npmLogPath.replace("debug-0", "debug-1"), "2 verbose exit 1\n");
  }, nextLogPath);
  expect(diagnostics(params.readLog()).logs[0].errorCodes).toEqual(["EPERM"]);
  expect(diagnostics(params.readLog(nextLogPath)).logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ errorCodes: ["ETIMEDOUT"] }),
      expect.objectContaining({ exitCode: 1 }),
    ]),
  );
  expect(params.readLog(nextLogPath)).not.toContain("EPERM");
});
