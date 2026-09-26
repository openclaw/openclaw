import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runSetupWizard } from "../wizard/setup.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";
import { setupCommand } from "./setup.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

afterEach(() => {
  noteMock.mockClear();
  closeOpenClawStateDatabaseForTest();
});

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

it("reports an unreadable config to setup entrypoints without repair advice", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const configPath = await writeOpenClawConfig(home, { $include: "missing.json" });
    const original = await fs.readFile(configPath, "utf8");

    const baseline = createRuntime();
    await expect(setupCommand({}, baseline)).rejects.toThrow("exit:1");
    const baselineJson = createRuntime();
    await expect(setupCommand({ json: true }, baselineJson)).rejects.toThrow("exit:1");
    const nonInteractive = createRuntime();
    await expect(
      runNonInteractiveSetup({ nonInteractive: true, acceptRisk: true }, nonInteractive),
    ).rejects.toThrow("exit:1");
    const classic = createRuntime();
    const prompter = makePrompter();
    await expect(runSetupWizard({ acceptRisk: true }, classic, prompter)).rejects.toThrow("exit:1");

    for (const output of [
      baseline.error.mock.calls,
      nonInteractive.error.mock.calls,
      vi.mocked(prompter.outro).mock.calls,
    ].map((calls) => calls.flat().join("\n"))) {
      expect(output).toContain(`OpenClaw config could not be read: ${configPath}`);
      expect(output).toContain("Failed to read include file: missing.json");
      expect(output).toContain("Resolve the read error shown above, then retry.");
      expect(output).not.toMatch(/config invalid|doctor --fix/i);
    }
    expect(vi.mocked(prompter.note).mock.calls.flat().join("\n")).not.toContain("Invalid config");
    expect(JSON.parse(String(baselineJson.log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("OpenClaw config could not be read:") },
      issues: [{ message: expect.stringContaining("Failed to read include file: missing.json") }],
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });
});

it("points failed setup to a repair that works without a terminal", async () => {
  const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const workspace = path.join(home, "workspace");
        const configPath = await writeOpenClawConfig(home, {
          agents: {
            defaults: { skipBootstrap: true, systemAgent: { agentId: "main" } },
            entries: { main: { workspace } },
          },
          browser: { enabled: false, actionTimeoutTypoMs: 5000 },
          gateway: { mode: "local" },
          logging: { level: "info", file: path.join(home, "doctor.log") },
          plugins: { enabled: false },
        });
        const original = await fs.readFile(configPath, "utf8");
        expect((await readConfigFileSnapshot()).valid).toBe(false);

        const baseline = createRuntime();
        await expect(setupCommand({ json: true }, baseline)).rejects.toThrow("exit:1");
        const nonInteractive = createRuntime();
        await expect(
          runNonInteractiveSetup(
            { nonInteractive: true, acceptRisk: true, json: true },
            nonInteractive,
          ),
        ).rejects.toThrow("exit:1");
        const classic = createRuntime();
        const prompter = makePrompter({
          select: vi.fn(async () => {
            throw new Error("Invalid config must stop before setup prompts");
          }),
        });
        await expect(runSetupWizard({ acceptRisk: true }, classic, prompter)).rejects.toThrow(
          "exit:1",
        );
        expect(prompter.select).not.toHaveBeenCalled();
        expect(prompter.outro).toHaveBeenCalledWith(
          "Config invalid. Run `openclaw doctor --fix` to apply supported repairs, then re-run setup.",
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(original);

        const guided = await prepareDoctorContext(configPath, { options: {} });
        expect(guided.prompter.repairMode.nonInteractive).toBe(true);
        expect(guided.configResult.shouldWriteConfig).toBe(false);
        expect(
          noteMock.mock.calls.some(([message]) => message.includes("actionTimeoutTypoMs")),
        ).toBe(true);
        await runInitialConfigWriteHealth(guided);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        expect((await readConfigFileSnapshot()).valid).toBe(false);

        const repair = await prepareDoctorContext(configPath, { options: { repair: true } });
        expect(repair.configResult.shouldWriteConfig).toBe(true);
        await runInitialConfigWriteHealth(repair);
        expect(repair.configResultWriteCommitted).toBe(true);
        const repaired = await readConfigFileSnapshot();
        expect(repaired.valid).toBe(true);
        expect(repaired.config.browser).toEqual({ enabled: false });
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);

        const retry = createRuntime();
        await setupCommand({ json: true }, retry);
        expect(retry.exit).not.toHaveBeenCalled();
        expect(retry.error).not.toHaveBeenCalled();
        expect(JSON.parse(String(retry.log.mock.calls[0]?.[0]))).toMatchObject({
          ok: true,
          workspaceDir: workspace,
          configStatus: "unchanged",
        });

        expect(baseline.error).toHaveBeenCalledWith(
          expect.stringContaining("openclaw doctor --fix"),
        );
        expect(nonInteractive.error).toHaveBeenCalledWith(
          "Config invalid. Run `openclaw doctor --fix` to apply supported repairs, then re-run setup.",
        );
      });
    });
  } finally {
    if (stdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  }
}, 30_000);
