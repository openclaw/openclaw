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
import { executeSystemAgentOperation, isPersistentSystemAgentOperation } from "./operations.js";
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
// mock-isolation: The install-file boundary has its own filesystem tests.
vi.mock("./read-install-file.js", () => ({ readSystemAgentInstallFile: vi.fn() }));

const tempDirs = createTempDirTracker();
const secret = "Authorization: Basic c2VjcmV0OnBhc3M=";
const floodText = `\u001b[31mfirst\u001b[0m ${secret}\n${"lorem ".repeat(3_000)}\nUNBOUNDED_TAIL`;
const writeFlood = (runtime: { log: (text: string) => void }) => {
  runtime.log(`\u001b[31mfirst\u001b[0m ${secret}`);
  runtime.log("lorem ".repeat(3_000));
  runtime.log("UNBOUNDED_TAIL");
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
    expect(isPersistentSystemAgentOperation(operation)).toBe(false);
    const { runtime, lines } = createSystemAgentTestRuntime();
    await expect(executeSystemAgentOperation(operation, runtime)).resolves.toEqual({
      applied: false,
    });
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

  it("gathers deep Gateway status with a probe, no exec secret refs and no repair", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation({ kind: "gateway-status-deep" }, runtime);
    expect(gatherDaemonStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        probe: true,
        deep: true,
        requireRpc: false,
        allowExecSecretRefs: false,
      }),
    );
    expect(vi.mocked(printDaemonStatus).mock.calls[0]?.[1]).toMatchObject({
      json: false,
      deep: true,
    });
  });

  it("reads one install file through the install-file boundary", async () => {
    vi.mocked(readSystemAgentInstallFile).mockResolvedValue("docs/index.md\nfile text");
    const { runtime, lines } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation(
      { kind: "read-install-file", path: "docs/index.md" },
      runtime,
    );
    expect(readSystemAgentInstallFile).toHaveBeenCalledWith("docs/index.md");
    expect(lines).toEqual(["docs/index.md\nfile text"]);
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
      const dir = tempDirs.make("system-agent-logs-");
      const file = path.join(dir, "openclaw-2026-01-22.log");
      const config = path.join(dir, "openclaw.json");
      await fs.writeFile(config, JSON.stringify({ logging: { redactSensitive: "tools" } }));
      await fs.writeFile(file, content);
      setLoggerOverride({ file });
      vi.stubEnv("OPENCLAW_CONFIG_PATH", config);
    }

    it("returns the redacted tail", async () => {
      await seedLog(`${secret}\nsecond line\n`);
      const { runtime, lines } = createSystemAgentTestRuntime();
      await executeSystemAgentOperation({ kind: "logs" }, runtime);
      const output = lines.join("\n");
      expect(output).toContain("second line");
      expect(output).toContain("untrusted data");
      expect(output).not.toContain("c2VjcmV0OnBhc3M=");
    });

    it("keeps only the newest 200 lines", async () => {
      await seedLog(
        Array.from(
          { length: 250 },
          (_, index) => `entry-${String(index + 1).padStart(4, "0")}\n`,
        ).join(""),
      );
      const { runtime, lines } = createSystemAgentTestRuntime();
      await executeSystemAgentOperation({ kind: "logs" }, runtime);
      const output = lines.join("\n");
      expect(output).toContain("entry-0250");
      expect(output).toContain("entry-0051");
      expect(output).not.toContain("entry-0050");
      expect(output).toContain("older lines omitted");
    });
  });
});
