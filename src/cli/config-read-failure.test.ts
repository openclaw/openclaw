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

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new ExitError(code);
    }),
  };
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

const entrypoints = [
  { name: "config validate", run: (host: RuntimeEnv) => validateConfig(host, false) },
  {
    name: "JSON config validate",
    json: true,
    run: (host: RuntimeEnv) => validateConfig(host, true),
  },
  {
    name: "gateway restart readiness",
    run: (host: RuntimeEnv) =>
      ensureConfigReady({ runtime: host, commandPath: ["gateway", "restart"] }),
  },
  {
    name: "command readiness",
    run: (host: RuntimeEnv) => ensureConfigReady({ runtime: host, commandPath: ["config", "get"] }),
  },
  {
    name: "JSON command readiness",
    json: true,
    run: (host: RuntimeEnv) => ensureConfigReady({ runtime: host, commandPath: ["config", "get"] }),
  },
  {
    name: "command config validation",
    run: (host: RuntimeEnv) => requireValidConfigFileSnapshot(host, { observe: false }),
  },
  {
    name: "config mutation validation",
    run: async (host: RuntimeEnv) =>
      ensureValidConfigSnapshotForCli(await readConfigFileSnapshot({ observe: false }), host),
  },
];

it.each(entrypoints)(
  "$name reports unavailable metadata without suggesting config repair",
  async ({ run, json }) => {
    await withOpenClawTestState({}, async (state) => {
      await state.writeConfig({ $include: "missing.json" });
      const before = await fs.readFile(state.configPath);
      if (json) {
        process.argv = [process.execPath, "openclaw", "config", "get", "gateway", "--json"];
      }
      const host = runtime();
      await expect(run(host)).rejects.toMatchObject({ name: "ExitError", code: 1 });
      const diagnostic = [
        ...host.error.mock.calls.flat(),
        ...(json ? host.log.mock.calls.flat() : []),
      ].join("\n");
      expect(diagnostic).toContain("OpenClaw config could not be read");
      expect(diagnostic).toContain("Failed to read include file: missing.json");
      expect(diagnostic).not.toContain("config is invalid");
      expect(diagnostic).not.toContain("doctor --fix");
      expect(diagnostic).not.toContain("config schema");
      expect(await fs.readFile(state.configPath)).toEqual(before);
      if (json) {
        expect(host.log).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(host.log.mock.calls[0]?.[0]))).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("OpenClaw config could not be read") },
          issues: [
            { message: expect.stringContaining("Failed to read include file: missing.json") },
          ],
        });
      }
    });
  },
);

it("keeps gateway probes available after a config read failure", async () => {
  await withOpenClawTestState({}, async (state) => {
    await state.writeConfig({ $include: "missing.json" });
    const host = runtime();
    await ensureConfigReady({ runtime: host, commandPath: ["gateway", "probe"] });
    expect(host.exit).not.toHaveBeenCalled();
    expect(host.error.mock.calls.flat().join("\n")).toContain("OpenClaw config could not be read");
  });
});

it.each([
  { name: "invalid JSON", raw: "{ bad" },
  { name: "invalid schema", raw: JSON.stringify({ gateway: { port: "bad" } }) },
])("retains invalid-config diagnosis and repair guidance for $name", async ({ raw }) => {
  await withOpenClawTestState({}, async (state) => {
    await fs.writeFile(state.configPath, raw);
    const host = runtime();
    await expect(
      ensureConfigReady({
        runtime: host,
        commandPath: ["config", "get"],
        suppressDoctorStdout: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    const diagnostic = host.error.mock.calls.flat().join("\n");
    expect(diagnostic).toContain("OpenClaw config is invalid");
    expect(diagnostic).toContain("doctor --fix");
    expect(diagnostic).not.toContain("config could not be read");
    expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
  });
});
