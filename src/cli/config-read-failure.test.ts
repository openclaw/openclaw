import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { requireValidConfigFileSnapshot } from "../commands/config-validation.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
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

const entrypoints = [
  {
    name: "command readiness",
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
  async ({ run }) => {
    await withOpenClawTestState({}, async (state) => {
      await state.writeConfig({ $include: "missing.json" });
      const before = await fs.readFile(state.configPath);
      const host = runtime();
      await expect(run(host)).rejects.toMatchObject({ name: "ExitError", code: 1 });
      const diagnostic = host.error.mock.calls.flat().join("\n");
      expect(diagnostic).toContain("OpenClaw config could not be read");
      expect(diagnostic).toContain("Failed to read include file: missing.json");
      expect(diagnostic).not.toContain("config is invalid");
      expect(diagnostic).not.toContain("doctor --fix");
      expect(await fs.readFile(state.configPath)).toEqual(before);
    });
  },
);

it("retains read-failure classification in JSON readiness output", async () => {
  await withOpenClawTestState({}, async (state) => {
    await state.writeConfig({ $include: "missing.json" });
    process.argv = [process.execPath, "openclaw", "config", "get", "gateway", "--json"];
    const host = runtime();
    await expect(
      ensureConfigReady({ runtime: host, commandPath: ["config", "get"] }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(host.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(host.log.mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("OpenClaw config could not be read") },
      issues: [{ message: expect.stringContaining("Failed to read include file: missing.json") }],
    });
  });
});

it("keeps read-only remote commands available after a config read failure", async () => {
  await withOpenClawTestState({}, async (state) => {
    await state.writeConfig({ $include: "missing.json" });
    const host = runtime();
    await ensureConfigReady({ runtime: host, commandPath: ["gateway", "call"] });
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
