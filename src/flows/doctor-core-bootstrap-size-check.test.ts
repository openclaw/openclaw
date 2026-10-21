import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import type { HealthFinding } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/bootstrap-size")!;
function expectFinding(findings: readonly HealthFinding[], fields: Partial<HealthFinding>) {
  expect(findings).toContainEqual(
    expect.objectContaining({ checkId: "core/doctor/bootstrap-size", ...fields }),
  );
}

describe("core/doctor/bootstrap-size", () => {
  let tmp: string | undefined;
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  async function workspace(files: Record<string, string>) {
    tmp = dirs.make("openclaw-health-bootstrap-");
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(dirname(join(tmp, name)), { recursive: true });
      await fs.writeFile(join(tmp, name), content, "utf-8");
    }
    return tmp;
  }
  function detect(cfg: OpenClawConfig = { agents: { defaults: { workspace: tmp } } }) {
    return check.detect({ mode: "lint", runtime, cfg, cwd: tmp });
  }

  afterEach(() => vi.unstubAllEnvs());

  it("does not create shared state while inspecting bootstrap files", async () => {
    const stateDir = join(await workspace({ "AGENTS.md": "bootstrap" }), "state-root");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await expect(detect()).resolves.toEqual([]);
    await expect(fs.stat(join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a hook-added extra file the total bootstrap budget dropped", async () => {
    // The extra repeats the root basename, so only source-path identity can tell
    // the doctor that this file received no injected bytes at all.
    const root = await workspace({
      "AGENTS.md": "a".repeat(1_000),
      "packages/core/AGENTS.md": "b".repeat(500),
    });

    const findings = await detect({
      agents: { defaults: { workspace: tmp, bootstrapTotalMaxChars: 1_000 } },
      hooks: {
        internal: {
          entries: {
            "bootstrap-extra-files": { enabled: true, paths: ["packages/*/AGENTS.md"] },
          },
        },
      },
    });

    expectFinding(findings, {
      severity: "warning",
      message: expect.stringContaining("AGENTS.md"),
      path: join(root, "packages", "core", "AGENTS.md"),
    });
  });

  it("honors the per-agent bootstrapMaxChars override in health findings", async () => {
    await workspace({ "AGENTS.md": "a".repeat(15_000) });
    const findings = await detect({
      agents: {
        defaults: { workspace: tmp, bootstrapMaxChars: 20_000 },
        entries: { "custom-agent": { bootstrapMaxChars: 10_000 } },
      },
    });

    expectFinding(findings, {
      severity: "warning",
      message: expect.stringContaining("AGENTS.md"),
      fixHint: expect.stringContaining("agents.entries.*.bootstrapMaxChars"),
    });
    await expect(
      check.detect({
        mode: "lint",
        runtime,
        cfg: {
          agents: {
            defaults: { bootstrapMaxChars: 20_000 },
            entries: { alpha: { workspace: tmp, bootstrapMaxChars: 10_000 }, beta: {} },
          },
        },
      }),
    ).resolves.toEqual([]);
  });

  it("keeps tuning advice for other files while USER.md near-limit names the fixed cap", async () => {
    await workspace({ "USER.md": "u".repeat(3_900), "AGENTS.md": "a".repeat(18_000) });
    const findings = await detect();

    const userFinding = findings.find((finding) => finding.message.includes("USER.md"));
    expect(userFinding).toMatchObject({
      checkId: "core/doctor/bootstrap-size",
      severity: "info",
      fixHint: expect.stringContaining("fixed 4,000-character bootstrap cap"),
    });
    expect(userFinding?.fixHint).not.toContain("tune");
    expectFinding(findings, {
      message: expect.stringContaining("AGENTS.md"),
      fixHint: expect.stringContaining("agents.entries.*.bootstrapMaxChars"),
    });
  });

  it("retains total-budget guidance when missing-file markers exhaust the USER.md budget", async () => {
    await workspace({ "USER.md": "u".repeat(5_000) });
    const findings = await detect({
      agents: { defaults: { workspace: tmp, bootstrapTotalMaxChars: 256 } },
    });

    const userFinding = findings.find((finding) => finding.message.includes("USER.md"));
    expect(userFinding?.fixHint).toContain("fixed 4,000-character bootstrap cap");
    expect(userFinding?.fixHint).toContain("agents.entries.*.bootstrapTotalMaxChars");
    expect(userFinding?.fixHint).not.toContain("tune `agents.entries.*.bootstrapMaxChars`");
    expect(findings.some((finding) => finding.message.startsWith("Total bootstrap context"))).toBe(
      false,
    );
  });
});
