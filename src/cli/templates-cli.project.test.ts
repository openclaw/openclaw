import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readTemplateDraft } from "../templates/draft.js";
import type { TemplateAddPlan } from "../templates/types.js";
import { registerTemplatesCli } from "./templates-cli.js";

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

  it("creates isolated private proposals without starting from the Control UI", async () => {
    const workspace = tempDirs.make("openclaw-chat-template-draft-");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const program = new Command().exitOverride();
      program.configureOutput({ writeErr: () => undefined });
      registerTemplatesCli(program);
      await program.parseAsync(["templates", "draft", workspace, "--json"], { from: "user" });
    }
    const drafts = payloads() as Array<{ draftId: string }>;
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.draftId).not.toBe(drafts[1]!.draftId);
    for (const { draftId } of drafts) {
      const draft = await readTemplateDraft(workspace, draftId);
      expect(JSON.parse(draft.content)).toMatchObject({
        scope: { input: "", job: "", output: "", authority: "" },
        files: [],
      });
    }
  });

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
    await expect(runTemplatesDevCommand(root, { ...options, agentId: "" })).rejects.toThrow(
      "__exit__:1",
    );
    expect(devPlan(5)).toMatchObject({
      agent: { finalId: "" },
      blockers: [expect.objectContaining({ code: "invalid_agent_id" })],
      actions: expect.arrayContaining([expect.objectContaining({ kind: "agent", blocked: true })]),
    });
    expect(existsSync(options.workspace)).toBe(false);
  });

  it.for([
    [runTemplatesCreateCommand, { name: "" }, "Project", "invalid_package_name"],
    [runTemplatesCreateCommand, { agentId: "" }, "Project", "invalid_agent_id"],
    [runTemplatesBuildCommand, {}, "Build", undefined],
    [runTemplatesDevCommand, {}, "Dev", undefined],
  ] as const)("reports failure %#", async ([run, ids, kind, code]) => {
    const dir = join(tempDirs.make("openclaw-template-errors-"), "missing");
    await expect(run(dir, { ...ids, out: `${dir}.tgz`, json: true })).rejects.toThrow("__exit__:1");
    const schemaVersion = `openclaw.template${kind}.v1`;
    expect(payloads()).toMatchObject([{ schemaVersion, ok: false }]);
    expect(payloads()[0]).toMatchObject({ error: { code: code ?? expect.any(String) } });
    expect(existsSync(dir)).toBe(false);
  });
});
