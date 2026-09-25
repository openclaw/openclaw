import childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDiagnosticFixtureRouting,
  diagnosticCanaries,
  diagnosticEnvReportScript,
  withSyntheticDiagnosticEnv,
} from "../infra/diagnostic-env.test-support.js";
import { getFileLockProcessStartTime, readDarwinProcessIdentity } from "./pid-alive.js";

const readers = [
  { name: "file-lock birth", read: getFileLockProcessStartTime },
  {
    name: "validation parent and birth",
    read: (pid: number, env?: NodeJS.ProcessEnv, timeoutMs?: number) =>
      readDarwinProcessIdentity(pid, env, timeoutMs)?.startedAt ?? null,
  },
];

afterEach(() => vi.restoreAllMocks());

it.each(readers)("bounds $name by the supplied process allowance", ({ read }) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  let elapsedMs = 0;
  vi.spyOn(childProcess, "execFileSync").mockImplementation((_file, _args, options) => {
    elapsedMs += options?.timeout ?? 0;
    throw new Error("native inspection timed out");
  });

  expect(read(424242, process.env, 125)).toBeNull();
  expect(elapsedMs).toBe(125);
});

it.each(readers)(
  "isolates $name while retaining its stable locale and timezone",
  async ({ read }) => {
    const nativeExec = childProcess.execFileSync;
    const routing = createDiagnosticFixtureRouting({
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      LC_ALL: "C",
      TZ: "UTC",
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    await withSyntheticDiagnosticEnv(
      { ...routing, LC_ALL: "fr_FR.UTF-8", TZ: "Pacific/Honolulu" },
      async () => {
        let report: unknown;
        const parent = { ...process.env };
        vi.spyOn(childProcess, "execFileSync").mockImplementation((_file, args, options) => {
          const stdout = nativeExec(
            process.execPath,
            ["-e", `process.stdout.write(${diagnosticEnvReportScript(routing)})`],
            { env: options?.env, encoding: "utf8", timeout: 5000 },
          );
          report = JSON.parse(stdout);
          return args?.[1] === "pid=,ppid=,lstart="
            ? "424242 1 Thu Sep  3 00:00:00 2026\n"
            : "Thu Sep  3 00:00:00 2026\n";
        });
        expect(read(424242)).toBe(Date.parse("2026-09-03T00:00:00Z") / 1000);
        expect(process.env).toEqual(parent);
        expect(report).toEqual({
          defined: Object.fromEntries(Object.keys(diagnosticCanaries).map((key) => [key, false])),
          routingPreserved: true,
        });
      },
    );
  },
);
