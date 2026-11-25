import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gatherDaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { printDaemonStatus } from "../cli/daemon-cli/status.print.js";
import { collectPluginsDoctorReport } from "../cli/plugins-doctor-report.js";
import { formatSkillsCheck } from "../cli/skills-cli.format.js";
import { loadSkillsStatusReport } from "../cli/skills-cli.js";
import { channelsStatusCommand } from "../commands/channels/status.js";
import { modelsStatusCommand } from "../commands/models/list.status-command.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { executeSystemAgentOperation } from "./operations.js";
import { readSystemAgentInstallFile } from "./read-install-file.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

// mock-isolation: Fixture command output proves the model-facing bound without reading live host state.
vi.mock("../cli/daemon-cli/status.gather.js", () => ({ gatherDaemonStatus: vi.fn() }));
// mock-isolation: Fixture rendering proves the injected runtime receives the deep status text.
vi.mock("../cli/daemon-cli/status.print.js", () => ({ printDaemonStatus: vi.fn() }));
// mock-isolation: Fixture plugin diagnostics avoid loading a plugin registry.
vi.mock("../cli/plugins-doctor-report.js", () => ({ collectPluginsDoctorReport: vi.fn() }));
// mock-isolation: Fixture skills report avoids a Gateway call.
vi.mock("../cli/skills-cli.js", () => ({ loadSkillsStatusReport: vi.fn() }));
// mock-isolation: Fixture skills rendering avoids a real skills catalog.
vi.mock("../cli/skills-cli.format.js", () => ({ formatSkillsCheck: vi.fn() }));
// mock-isolation: Fixture channel output avoids a Gateway call.
vi.mock("../commands/channels/status.js", () => ({ channelsStatusCommand: vi.fn() }));
// mock-isolation: Fixture model output avoids auth stores and catalogs.
vi.mock("../commands/models/list.status-command.js", () => ({ modelsStatusCommand: vi.fn() }));
vi.mock("./read-install-file.js", { spy: true });

const tempDirs = createTempDirTracker();
const secret = "Authorization: Basic c2VjcmV0OnBhc3M=";
const floodText = `\u001b[31mfirst\u001b[0m ${secret}\n${"lorem ".repeat(3_000)}\nUNBOUNDED_TAIL`;
const writeFlood = (runtime: { log: (text: string) => void }) => {
  floodText.split("\n").forEach((line) => runtime.log(line));
};

beforeEach(() => {
  vi.mocked(gatherDaemonStatus).mockResolvedValue({} as never);
  vi.mocked(loadSkillsStatusReport).mockResolvedValue({} as never);
  vi.mocked(formatSkillsCheck).mockReturnValue(floodText);
  vi.mocked(collectPluginsDoctorReport).mockResolvedValue({ output: floodText, exitCode: 1 });
  vi.mocked(channelsStatusCommand).mockImplementation(async (_opts, runtime) =>
    writeFlood(runtime!),
  );
  vi.mocked(modelsStatusCommand).mockImplementation(async (_opts, runtime) => writeFlood(runtime));
  vi.mocked(printDaemonStatus).mockImplementation((_status, opts) => writeFlood(opts.runtime!));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetLogger();
  tempDirs.cleanup();
});

describe("system agent diagnostic reads", () => {
  it.each([
    [{ kind: "plugins-doctor" }],
    [{ kind: "channels-status" }],
    [{ kind: "channels-status", probe: true }],
    [{ kind: "models-status" }],
    [{ kind: "gateway-status-deep" }],
    [{ kind: "skills-check" }],
  ] as const)("runs %j read-only with bounded, redacted, plain output", async (operation) => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    expect(await executeSystemAgentOperation(operation, runtime)).toEqual({ applied: false });
    const output = lines.join("\n");
    expect(output).toContain("first");
    expect(output).toContain("output limit reached");
    expect(output).not.toContain("\u001b[");
    expect(output).not.toContain("c2VjcmV0OnBhc3M=");
    expect(output).not.toContain("UNBOUNDED_TAIL");
    expect(output.length).toBeLessThanOrEqual(8_100);
  });

  it("passes probe only to channels_status and never to models_status", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation({ kind: "channels-status" }, runtime);
    await executeSystemAgentOperation({ kind: "channels-status", probe: true }, runtime);
    await executeSystemAgentOperation({ kind: "models-status" }, runtime);
    expect(vi.mocked(channelsStatusCommand).mock.calls.map(([opts]) => opts)).toEqual([
      { probe: false },
      { probe: true },
    ]);
    expect(vi.mocked(modelsStatusCommand).mock.calls[0]?.[0]).toEqual({});
  });

  it("probes deep Gateway status without exec secret refs or log excerpts", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation({ kind: "gateway-status-deep" }, runtime);
    expect(gatherDaemonStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        probe: true,
        deep: true,
        requireRpc: false,
        allowExecSecretRefs: false,
        includeLogExcerpt: false,
      }),
    );
    expect(vi.mocked(printDaemonStatus).mock.calls[0]?.[1]).toMatchObject({
      json: false,
      deep: true,
      showProcessArguments: false,
    });
  });

  it("labels file reads as local CLI profile output", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDirs.make("setup-"), "config.json"));
    vi.mocked(readSystemAgentInstallFile).mockResolvedValueOnce("file text");
    const { runtime, lines } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation({ kind: "read-install-file", path: "guide.md" }, runtime);
    expect(readSystemAgentInstallFile).toHaveBeenCalledWith("guide.md");
    expect(lines[0]).toMatch(/^Local CLI profile file.*openclaw logs.*\nfile text$/u);
  });

  it("answers skills_check on the CLI surface without creating a device identity", async () => {
    const stateDir = tempDirs.make("system-agent-no-identity-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    await expect(
      executeSystemAgentOperation({ kind: "skills-check" }, runtime, {
        deps: { setupSurface: "cli" },
      }),
    ).resolves.toEqual({ applied: false });
    expect(lines.join("\n")).toContain("no device identity");
    expect(lines.join("\n")).toContain("openclaw skills check");
    expect(loadSkillsStatusReport).not.toHaveBeenCalled();
    await expect(fs.readdir(stateDir)).resolves.toEqual([]);
  });

  describe("logs", () => {
    async function seedLog(content: string) {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
      const dir = tempDirs.make(".system-agent-logs-");
      const file = path.join(dir, "gateway.log");
      const config = path.join(tempDirs.make("system-agent-config-"), "openclaw.json");
      await fs.writeFile(config, JSON.stringify({ logging: { redactSensitive: "off" } }));
      await fs.writeFile(file, content);
      setLoggerOverride({ file });
      vi.stubEnv("OPENCLAW_CONFIG_PATH", config);
      return { dir, config, file };
    }

    it("redacts local logs and refuses remote CLI and protected host reads", async () => {
      const { config, dir, file } = await seedLog(`${secret}\nsecond line\n`);
      const { runtime, lines } = createSystemAgentTestRuntime();
      await executeSystemAgentOperation({ kind: "logs" }, runtime);
      expect(lines[0]).toMatch(/^Local CLI profile log tail.*untrusted data.*second line/su);
      expect(lines.join("")).not.toContain("c2VjcmV0OnBhc3M=");
      await fs.writeFile(config, '{"gateway":{"mode":"remote"}}');
      await executeSystemAgentOperation({ kind: "logs" }, runtime);
      const privateLogDir = path.join(path.dirname(config), "logs");
      await fs.symlink(dir, privateLogDir, "junction");
      setLoggerOverride({ file: path.join(privateLogDir, path.basename(file)) });
      const hosted = { deps: { setupSurface: "gateway" as const } };
      const readHostLog = () => executeSystemAgentOperation({ kind: "logs" }, runtime, hosted);
      const scopeError = "outside the diagnostics read scope";
      await expect(readHostLog()).rejects.toThrow(scopeError);
      setLoggerOverride({ file });
      const sibling = path.join(dir, "notes.txt");
      await fs.rename(file, sibling);
      for (const link of [fs.symlink, fs.link]) {
        await link(sibling, file);
        await expect(readHostLog()).rejects.toThrow(scopeError);
        await fs.unlink(file);
      }
      expect(lines.slice(1)).toEqual([expect.stringContaining("only read diagnostic files")]);
    });

    it("keeps only the newest 200 lines", async () => {
      await seedLog(Array.from({ length: 250 }, (_, index) => `entry-${index + 1}\n`).join(""));
      const { runtime, lines } = createSystemAgentTestRuntime();
      await executeSystemAgentOperation({ kind: "logs" }, runtime);
      expect(lines[0]).toMatch(/older lines omitted[\s\S]*\nentry-51\n[\s\S]*\nentry-250$/u);
      expect(lines[0]).not.toContain("entry-50");
    });
  });
});
