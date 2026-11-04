import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { TemplateAddPlan } from "../templates/types.js";

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

const {
  runTemplatesBuildCommand,
  runTemplatesCreateCommand,
  runTemplatesDevCommand,
  runTemplatesValidateCommand,
} = await import("./templates-cli.project.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const payloads = () => runtime.writeJson.mock.calls.map(([value]) => value);
const devPlan = (index: number) => (payloads()[index] as { plan: TemplateAddPlan }).plan;

describe("Template project CLI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("previews a Template with ordinary sessions_spawn authority", async () => {
    await runTemplatesDevCommand("src/templates/fixtures/delegating-agent", {
      workspace: join(tempDirs.make("openclaw-template-delegation-preview-"), "workspace"),
    });
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringMatching(/^Model:|^Delegation:/));
    expect(runtime.log).toHaveBeenCalledWith("Blocked actions: 0");
  });

  it("runs create, validate, build, and offline dev against the built artifact", async () => {
    const root = join(tempDirs.make("openclaw-template-author-"), "author-flow");
    const artifact = join(tempDirs.make("openclaw-template-author-output-"), "author-flow.tgz");
    await runTemplatesCreateCommand(root, { json: true });
    await runTemplatesValidateCommand(root, { json: true });
    await runTemplatesBuildCommand(root, { out: artifact, json: true });
    const options = {
      agentId: "author-flow-preview",
      workspace: join(root, "preview-workspace"),
      json: true,
    };
    await runTemplatesDevCommand(root, options);
    expect(payloads()).toMatchObject([
      { schemaVersion: "openclaw.templateProject.v1" },
      { schemaVersion: "openclaw.templateProject.v1", excludedPaths: [] },
      { schemaVersion: "openclaw.templateBuild.v1", excludedPaths: [] },
      { schemaVersion: "openclaw.templateDev.v1", mutationAllowed: false, offline: true },
    ]);
    const { integrity } = payloads()[2] as { integrity: string };
    expect(devPlan(3)).toMatchObject({
      mutationAllowed: false,
      blockers: [],
      template: {
        integrityKind: "artifact",
        integrity,
        packageRoot: `template-artifact:${integrity}`,
      },
    });
    const first = devPlan(3);
    await runTemplatesDevCommand(root, options);
    expect(first).toEqual(devPlan(4));
    expect(JSON.stringify(first)).not.toContain("openclaw-template-artifact-");
    expect(first.template.packageRoot).toMatch(/^template-artifact:sha256:/u);
  });

  it("uses command-specific schemas for build and dev failures", async () => {
    const missing = join(tempDirs.make("openclaw-template-errors-"), "missing");
    await expect(
      runTemplatesBuildCommand(missing, {
        out: join(tempDirs.make("openclaw-template-error-output-"), "missing.tgz"),
        json: true,
      }),
    ).rejects.toThrow("__exit__:1");
    await expect(runTemplatesDevCommand(missing, { json: true })).rejects.toThrow("__exit__:1");
    expect(payloads()).toMatchObject([
      { schemaVersion: "openclaw.templateBuild.v1", ok: false },
      { schemaVersion: "openclaw.templateDev.v1", ok: false },
    ]);
  });
});
