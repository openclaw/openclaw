import fs from "node:fs/promises";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { requireValidConfigFileSnapshot } from "../commands/config-validation.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { defaultRuntime, ExitError, type RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ensureValidConfigSnapshotForCli } from "./config-cli-validation.js";
import { ensureConfigReady, testApi } from "./program/config-guard.js";

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  testApi.resetConfigGuardStateForTests();
});
const runtime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn((code: number): never => {
    throw new ExitError(code);
  }),
});
const ready =
  (commandPath = ["config", "get"], suppressDoctorStdout?: boolean) =>
  (host: RuntimeEnv) =>
    ensureConfigReady({ runtime: host, commandPath, suppressDoctorStdout });
const unreadable = "OpenClaw config could not be read";
const missingInclude = "Failed to read include file: missing.json";
const unreadableConfig = JSON.stringify({ $include: "missing.json" });

function withConfig(raw: string, run: (host: ReturnType<typeof runtime>) => Promise<void>) {
  return withOpenClawTestState({}, async (state) => {
    await fs.writeFile(state.configPath, raw);
    await run(runtime());
    expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
  });
}

async function validateConfig(host: RuntimeEnv, json: boolean) {
  const { registerConfigCli } = await import("./config-cli.js");
  const program = new Command();
  registerConfigCli(program);
  const spies = [
    vi.spyOn(defaultRuntime, "log").mockImplementation(host.log),
    vi.spyOn(defaultRuntime, "error").mockImplementation(host.error),
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value, space = 2) => {
      host.log(JSON.stringify(value, undefined, space));
    }),
    vi.spyOn(defaultRuntime, "exit").mockImplementation(host.exit),
  ];
  try {
    await program.parseAsync([
      "node",
      "openclaw",
      "config",
      "validate",
      ...(json ? ["--json"] : []),
    ]);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

it.each([
  ["config validate", (host) => validateConfig(host, false)],
  ["JSON config validate", (host) => validateConfig(host, true), true],
  ["gateway restart readiness", ready(["gateway", "restart"])],
  ["command readiness", ready()],
  ["JSON command readiness", ready(), true],
  ["command config validation", (host) => requireValidConfigFileSnapshot(host, { observe: false })],
  [
    "config mutation validation",
    async (host) =>
      ensureValidConfigSnapshotForCli(await readConfigFileSnapshot({ observe: false }), host),
  ],
] satisfies [string, (host: RuntimeEnv) => unknown, boolean?][])(
  "%s reports unavailable metadata without suggesting config repair",
  async (_name, run, json?: boolean) =>
    withConfig(unreadableConfig, async (host) => {
      if (json) {
        process.argv = [process.execPath, "openclaw", "config", "get", "gateway", "--json"];
      }
      await expect(run(host)).rejects.toMatchObject({ name: "ExitError", code: 1 });
      const diagnostic = [
        ...host.error.mock.calls.flat(),
        ...(json ? host.log.mock.calls.flat() : []),
      ].join("\n");
      expect(diagnostic).toContain(unreadable);
      expect(diagnostic).toContain(missingInclude);
      expect(diagnostic).not.toContain("config is invalid");
      expect(diagnostic).not.toContain("doctor --fix");
      expect(diagnostic).not.toContain("config schema");
      if (json) {
        expect(host.log).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(host.log.mock.calls[0]?.[0]))).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining(unreadable) },
          issues: [{ message: expect.stringContaining(missingInclude) }],
        });
      }
    }),
);

it("keeps gateway probes available after a config read failure", async () =>
  withConfig(unreadableConfig, async (host) => {
    await ready(["gateway", "probe"])(host);
    expect(host.exit).not.toHaveBeenCalled();
    expect(host.error.mock.calls.flat().join("\n")).toContain(unreadable);
  }));

it.each([
  ["invalid JSON", "{ bad"],
  ["invalid schema", JSON.stringify({ gateway: { port: "bad" } })],
])("retains invalid-config diagnosis and repair guidance for %s", async (_name, raw) =>
  withConfig(raw, async (host) => {
    await expect(ready(undefined, true)(host)).rejects.toMatchObject({
      name: "ExitError",
      code: 1,
    });
    const diagnostic = host.error.mock.calls.flat().join("\n");
    expect(diagnostic).toContain("OpenClaw config is invalid");
    expect(diagnostic).toContain("doctor --fix");
    expect(diagnostic).not.toContain("config could not be read");
  }),
);
