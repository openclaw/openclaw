import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ClawAddPlan } from "../claws/types.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  writeJson: vi.fn<(value: unknown) => void>(),
  writeStdout: vi.fn(),
  exit: vi.fn((code: number) => {
    throw new Error(`__exit__:${code}`);
  }),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: runtime,
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: async () => ({
    valid: true,
    resolved: {},
  }),
}));

const { runClawsBuildCommand, runClawsCreateCommand, runClawsDevCommand, runClawsValidateCommand } =
  await import("./claws-cli.project.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const payloads = () => runtime.writeJson.mock.calls.map(([value]) => value);
const devPlan = (index: number) => (payloads()[index] as { plan: ClawAddPlan }).plan;

describe("Claw project CLI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("previews a Claw with ordinary sessions_spawn authority", async () => {
    await runClawsDevCommand("src/claws/fixtures/delegating-agent", {
      workspace: join(tempDirs.make("openclaw-claw-delegation-preview-"), "workspace"),
    });
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringMatching(/^Model:|^Delegation:/));
    expect(runtime.log).toHaveBeenCalledWith("Blocked actions: 0");
  });

  it("runs create, validate, build, and offline dev against the built artifact", async () => {
    const root = join(tempDirs.make("openclaw-claw-author-"), "author-flow");
    const artifact = join(tempDirs.make("openclaw-claw-author-output-"), "author-flow.tgz");
    await runClawsCreateCommand(root, { json: true });
    await runClawsValidateCommand(root, { json: true });
    await runClawsBuildCommand(root, { out: artifact, json: true });
    const options = {
      agentId: "author-flow-preview",
      workspace: join(root, "preview-workspace"),
      json: true,
    };
    await runClawsDevCommand(root, options);
    expect(payloads()).toMatchObject([
      { schemaVersion: "openclaw.clawProject.v1" },
      { schemaVersion: "openclaw.clawProject.v1", excludedPaths: [] },
      { schemaVersion: "openclaw.clawBuild.v1", excludedPaths: [] },
      { schemaVersion: "openclaw.clawDev.v1", mutationAllowed: false, offline: true },
    ]);
    const { integrity } = payloads()[2] as { integrity: string };
    expect(devPlan(3)).toMatchObject({
      mutationAllowed: false,
      blockers: [],
      claw: {
        integrityKind: "artifact",
        integrity,
        packageRoot: `claw-artifact:${integrity}`,
      },
    });
    const first = devPlan(3);
    await runClawsDevCommand(root, options);
    expect(first).toEqual(devPlan(4));
    expect(JSON.stringify(first)).not.toContain("openclaw-claw-artifact-");
    expect(first.claw.packageRoot).toMatch(/^claw-artifact:sha256:/u);
  });

  it("keeps terminal controls out of the human Claw project report", async () => {
    // A checked-out Claw project can carry control characters in its directory and file names.
    const root = join(tempDirs.make("openclaw-claw-controls-"), "author\x1b[2J\x07");
    await runClawsCreateCommand(root, { name: "author-flow", json: true });
    const excluded = "payload\x1b[2J\x07\n.bin";
    await writeFile(join(root, excluded), "payload\n");
    await runClawsValidateCommand(root, {});
    const report = runtime.log.mock.calls.map(([value]) => String(value)).join(" | ");
    expect(report).toContain("Package: author-flow@0.1.0");
    expect(report).not.toMatch(/\p{Cc}/u);
    expect(report).toContain("\\n");

    await runClawsValidateCommand(root, { json: true });
    const payload = payloads().at(-1) as { root: string; excludedPaths: string[] };
    expect(payload.root).toContain("author\x1b[2J\x07");
    expect(payload.excludedPaths).toContain(excluded);
  });

  it("uses command-specific schemas for build and dev failures", async () => {
    const missing = join(tempDirs.make("openclaw-claw-errors-"), "missing");
    await expect(
      runClawsBuildCommand(missing, {
        out: join(tempDirs.make("openclaw-claw-error-output-"), "missing.tgz"),
        json: true,
      }),
    ).rejects.toThrow("__exit__:1");
    await expect(runClawsDevCommand(missing, { json: true })).rejects.toThrow("__exit__:1");
    expect(payloads()).toMatchObject([
      { schemaVersion: "openclaw.clawBuild.v1", ok: false },
      { schemaVersion: "openclaw.clawDev.v1", ok: false },
    ]);
  });
});
