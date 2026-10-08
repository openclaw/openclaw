import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";
import { afterEach, expect, it } from "vitest";
import {
  proveRepairReadiness,
  withReadinessAuthFault,
} from "../../scripts/e2e/lib/upgrade-survivor/repair-readiness.mjs";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const unit =
  "[Service]\nExecStart=/usr/bin/node /fixture/openclaw.mjs gateway --port 18789\nEnvironment=KEEP=original\n";

it("adds only a generated-command auth fault and refuses competing token ownership", () => {
  const faulted = withReadinessAuthFault(unit);
  expect(faulted.replace(" --token repair-readiness-synthetic-server-token", "")).toBe(unit);
  expect(() => withReadinessAuthFault(faulted)).toThrow("existing token argument");
  expect(() => withReadinessAuthFault(unit + "ExecStart=/another\n")).toThrow(
    "one generated service",
  );
});

it.each([
  "passes",
  "false-success",
  "wrong-build",
  "lost-history",
  "cleanup-failure",
  "timeout-cleanup",
])("keeps readiness proof fail-closed: %s", async (caseName) => {
  const root = dirs.make("repair-readiness-harness-");
  const unitPath = join(root, ".config/systemd/user/openclaw-gateway.service");
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit);
  const configPath = join(root, "config.json");
  const sidecar = join(root, "auth.json");
  writeFileSync(configPath, "original config");
  writeFileSync(sidecar, "original credential");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    OPENCLAW_CONFIG_PATH: configPath,
    npm_config_prefix: root,
  };
  const calls: Array<{ name: string; args: string[]; marker: string | undefined }> = [];
  const warning = "Gateway readiness: reachable (health-unavailable)";
  const output = (name: string) => {
    if (name === "readiness-lifecycle") {
      return { ok: true, result: "restarted", warnings: [warning] };
    }
    if (name === "readiness-strict") {
      return { ok: false, result: "restart-health-failed", warnings: [warning] };
    }
    if (name === "readiness-stopped-status") {
      return { service: { runtime: { status: "stopped" } }, rpc: { ok: false } };
    }
    return {
      targets: [
        {
          url: "ws://127.0.0.1:18789",
          connect: { ok: true },
          server: {
            version: "2026.10.1",
            buildId: caseName === "wrong-build" ? "wrong" : "candidate",
          },
        },
      ],
    };
  };
  const run = async (name: string, _command: string, args: string[]) => {
    calls.push({ name, args, marker: env.OPENCLAW_UPDATE_IN_PROGRESS });
    if (caseName === "cleanup-failure" && name === "readiness-lifecycle") {
      throw new Error("first proof failure");
    }
    if (caseName === "timeout-cleanup" && name === "readiness-strict") {
      throw Object.assign(new Error("primary timeout"), {
        command: name,
        exitCode: 124,
        code: "ETIMEDOUT",
        processTreeState: "terminated",
      });
    }
    if (
      ["cleanup-failure", "timeout-cleanup"].includes(caseName) &&
      name === "readiness-restore-unit"
    ) {
      throw new Error("second cleanup failure");
    }
    return {
      status: name === "readiness-strict" && caseName !== "false-success" ? 1 : 0,
      signal: null,
    };
  };
  const proof = proveRepairReadiness({
    run,
    output,
    env,
    build: { version: "2026.10.1", buildId: "candidate" },
    port: 18789,
    token: "fixture",
    orphanSidecar: sidecar,
    sessions: [
      { kind: "durable", sessionId: "session", marker: "keep", params: { sessionKey: "key" } },
    ],
    gateway: async (_name: string, method: string) =>
      method === "health"
        ? { ok: true, readiness: { state: "ready" } }
        : { sessionId: "session", messages: [caseName === "lost-history" ? "lost" : "keep"] },
  });
  if (caseName === "passes") {
    await expect(proof).resolves.toMatchObject({ preserved: true, strictExit: { status: 1 } });
    expect(
      calls
        .filter((call) => call.args.includes("restart"))
        .map(({ name, marker }) => ({ name, marker })),
    ).toEqual([
      { name: "readiness-lifecycle", marker: undefined },
      { name: "readiness-strict", marker: "1" },
      { name: "readiness-recovered", marker: "1" },
    ]);
    expect(calls.at(-1)?.name).toBe("readiness-stopped-status");
    expect(calls.find((call) => call.name === "readiness-stop")?.args).toEqual([
      "gateway",
      "stop",
      "--force",
      "--json",
    ]);
  } else if (caseName === "timeout-cleanup") {
    await expect(proof).rejects.toMatchObject({
      command: "readiness-strict",
      exitCode: 124,
      code: "ETIMEDOUT",
      cause: { message: "primary timeout" },
      errors: [
        expect.objectContaining({ message: "primary timeout" }),
        expect.objectContaining({ message: "second cleanup failure" }),
      ],
    });
  } else if (caseName === "cleanup-failure") {
    await expect(proof).rejects.toMatchObject({
      cause: { message: "first proof failure" },
      errors: [
        expect.objectContaining({ message: "first proof failure" }),
        expect.objectContaining({ message: "second cleanup failure" }),
      ],
    });
  } else {
    await expect(proof).rejects.toThrow();
    expect(calls.some((call) => call.name === "readiness-recovered")).toBe(false);
  }
  expect(env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
  expect(readFileSync(unitPath, "utf8")).toBe(unit);
  expect(readFileSync(configPath, "utf8")).toBe("original config");
  expect(readFileSync(sidecar, "utf8")).toBe("original credential");
});

it("admits only the explicit trusted 2026.9.7 and 2026.9.8 readiness scenarios", async () => {
  const policy = await import("../../scripts/lib/upgrade-survivor-policy.mjs");
  expect(policy.isTrustedHarnessOwnedUpgradeSurvivorScenario("repair-readiness")).toBe(true);
  expect(policy.parseUpgradeSurvivorScenarios("repair-readiness")).toEqual(["repair-readiness"]);
  expect(policy.parseUpgradeSurvivorScenarios("reported-issues far-reaching")).not.toContain(
    "repair-readiness",
  );
  for (const baseline of [
    "openclaw@2026.9.6",
    "openclaw@2026.9.7",
    "openclaw@2026.9.8",
    "openclaw@2026.9.9",
    "openclaw@latest",
  ]) {
    expect(policy.supportsUpgradeSurvivorScenarioAtBaseline("repair-readiness", baseline)).toBe(
      ["openclaw@2026.9.7", "openclaw@2026.9.8"].includes(baseline),
    );
  }
});

it.each(["stop-service", "runtime-cleanup", "primary-timeout"])(
  "captures the final first failure after %s",
  async (fault) => {
    const source = readFileSync("scripts/e2e/lib/upgrade-survivor/published-driver.mjs", "utf8");
    const start = source.indexOf("  if (!failures.some(hasUnjoinedWork) && fixtureInstalled) {");
    const finalization = source
      .slice(start, source.lastIndexOf("});"))
      .replaceAll("import.meta.url", '"file:///fixture/published-driver.mjs"');
    expect(start).toBeGreaterThan(0);
    const failures =
      fault === "primary-timeout"
        ? [
            Object.assign(new Error("primary timeout"), {
              command: "readiness-strict",
              exitCode: 124,
            }),
          ]
        : [];
    const snapshots: Record<string, unknown> = {};
    const captures: string[][] = [];
    const execute = compileFunction("return (async () => {" + finalization + "})()", [
      "failures",
      "hasUnjoinedWork",
      "fixtureInstalled",
      "repairReadiness",
      "run",
      "fs",
      "path",
      "bin",
      "runtime",
      "artifacts",
      "scenario",
      "writeJson",
      "fileURLToPath",
      "console",
    ]);
    const code = await execute(
      failures,
      hasUnjoinedWork,
      true,
      true,
      async (name: string, _bin: string, args: string[]) => {
        if (name === "stop-service" && fault !== "runtime-cleanup") {
          throw Object.assign(new Error("stop failed"), { command: name, exitCode: 37 });
        }
        if (name === "capture-diagnostics") {
          captures.push(args);
        }
      },
      {
        readFileSync: () => "last-phase",
        writeFileSync: () => {},
        rmSync: () => {
          if (fault === "runtime-cleanup") {
            throw new Error("remove failed");
          }
        },
      },
      { join: (...parts: string[]) => parts.join("/") },
      "/bin",
      "/runtime",
      "/artifacts",
      "repair-readiness",
      (name: string, value: unknown) => {
        snapshots[name] = value;
      },
      (url: URL) => url.pathname,
      { error: () => {} },
    );
    const expected = fault === "primary-timeout" ? 124 : fault === "stop-service" ? 37 : 1;
    expect(code).toBe(expected);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.at(-1)).toBe(String(expected));
    expect(snapshots["repair-readiness-outcome"]).toMatchObject({
      failures: [
        expect.objectContaining({
          message: expect.stringContaining(
            fault === "primary-timeout"
              ? "primary timeout"
              : fault === "stop-service"
                ? "stop failed"
                : "remove failed",
          ),
        }),
        ...(fault === "primary-timeout" ? [expect.any(Object)] : []),
      ],
    });
  },
);
