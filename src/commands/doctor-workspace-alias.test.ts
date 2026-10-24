import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workspaceAliases from "../agents/workspace-alias-rebind.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";
import {
  collectRepointedWorkspaceAliasFindings,
  createWorkspaceAliasMigrationRepair,
} from "./doctor-workspace-alias.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({ layout: "state-only", prefix: "doctor-alias-" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

function buildPrompter(confirm = async () => false, shouldRepair = true): DoctorPrompter {
  return {
    ...createDoctorPrompter({
      runtime: createTestRuntime(),
      options: { repair: shouldRepair, nonInteractive: true },
    }),
    confirmAutoFix: vi.fn(async () => true),
    confirmRuntimeRepair: vi.fn(confirm),
  };
}

function buildAliasCfg(aliasPath: string, other?: string): OpenClawConfig {
  const entries = {
    main: { workspace: aliasPath },
    ...(other ? { legacy: { workspace: other } } : {}),
  };
  return { agents: { entries } };
}

function runWorkspaceRepair(cfg: OpenClawConfig, prompter: DoctorPrompter) {
  return createWorkspaceAliasMigrationRepair(prompter)!(cfg);
}

function link(target: string, alias: string) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}
async function expectState(directory: string, exists: boolean) {
  expect((await readWorkspaceStateSnapshot(directory)).setupExists).toBe(exists);
}
async function repointAlias(params: { seedAttestedFile?: boolean; name?: string } = {}) {
  const original = params.name ? testState!.path(params.name, "original") : testState!.workspaceDir;
  const localPath = (name: string) => testState!.path(params.name ?? "", name);
  const alias = localPath("workspace-link");
  const replacement = localPath("replacement-workspace");
  fs.mkdirSync(original, { recursive: true });
  link(original, alias);
  await mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
  if (params.seedAttestedFile) {
    const content = "seeded bootstrap content";
    fs.writeFileSync(path.join(original, "BOOTSTRAP.md"), content);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    await replaceWorkspaceAttestation({
      workspaceDir: alias,
      attestedAtMs: 1_000,
      generatedHashes: new Map([["BOOTSTRAP.md", hash]]),
      nowMs: 1_000,
    });
  }
  fs.renameSync(original, replacement);
  fs.unlinkSync(alias);
  link(replacement, alias);
  return { alias, original, replacement };
}

it.each(["configuration", "target"])("rechecks %s after confirmation", async (change) => {
  const { alias, original, replacement } = await repointAlias({ seedAttestedFile: true });
  const cfg = buildAliasCfg(alias);
  const target = change === "target" ? testState!.path("changed-target") : replacement;
  if (change === "configuration") {
    await testState!.writeConfig(cfg);
  } else {
    fs.mkdirSync(target);
  }
  const prompter = buildPrompter(async () => {
    if (change === "configuration") {
      await testState!.writeConfig(buildAliasCfg(alias, original));
    } else {
      fs.unlinkSync(alias);
      link(target, alias);
    }
    return true;
  });
  await expect(runWorkspaceRepair(cfg, prompter)).rejects.toThrow();
  await expectState(original, true);
  await expectState(target, false);
});

it("shares one private snapshot across alias findings and rereads committed repairs", async () => {
  const aliases = [];
  for (const name of ["first", "second", "third"]) {
    aliases.push(await repointAlias({ name }));
  }
  const entries = aliases.map(({ alias }, i) => ["agent-" + i, { workspace: alias }]);
  const cfg: OpenClawConfig = { agents: { entries: Object.fromEntries(entries) } };
  const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
  const inspect = async () => {
    closeOpenClawStateDatabaseForTest();
    prepare.mockClear();
    const findings = await withArtifactPreservingStateReads(() =>
      collectRepointedWorkspaceAliasFindings(cfg),
    );
    expect(prepare).toHaveBeenCalledOnce();
    const location = prepare.mock.results[0]?.value.location;
    expect(fs.existsSync(location)).toBe(false);
    return { findings, location };
  };
  const first = await inspect();
  expect(first.findings).toMatchObject(
    aliases.map(({ alias }) => ({
      checkId: "core/doctor/workspace-alias",
      severity: "warning",
      fixHint: expect.stringContaining("doctor --fix"),
      message: expect.stringContaining(alias),
    })),
  );

  const firstAlias = aliases[0]!.alias;
  expect(
    await workspaceAliases.rebindRepointedWorkspaceAlias(
      firstAlias,
      workspaceAliases.detectRepointedWorkspaceAlias(firstAlias)!,
      {},
      aliases.map(({ alias }) => alias),
    ),
  ).toBe("rebound");
  const next = await inspect();
  expect(next.findings.map(({ message }) => message)).toEqual(
    aliases.slice(1).map(({ alias }) => expect.stringContaining(alias)),
  );
  expect(next.location).not.toBe(first.location);
});

it("requires explicit confirmation even when generated hashes match", async () => {
  const { alias, original } = await repointAlias({ seedAttestedFile: true });
  const prompter = buildPrompter();

  await expect(runWorkspaceRepair(buildAliasCfg(alias), prompter)).rejects.toThrow();

  expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
  expect(prompter.confirmRuntimeRepair).toHaveBeenCalledOnce();
  await expectState(original, true);

  const approving = buildPrompter(async () => true);
  await runWorkspaceRepair(buildAliasCfg(alias), approving);
  const snapshot = await readWorkspaceStateSnapshot(alias);
  expect(snapshot).toMatchObject({
    setupExists: true,
    setup: { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" },
  });

  const secondPrompter = buildPrompter();
  await runWorkspaceRepair(buildAliasCfg(alias), secondPrompter);
  expect(secondPrompter.confirmRuntimeRepair).not.toHaveBeenCalled();
});

it.each(["target", "agent", "diagnostic"])("leaves state untouched for %s", async (owner) => {
  const { alias, original, replacement } = await repointAlias({
    seedAttestedFile: owner === "diagnostic",
  });
  if (owner === "target") {
    await mergeWorkspaceSetupState(
      replacement,
      { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" },
      2_000,
    );
  }
  const prompter = buildPrompter(async () => true, owner !== "diagnostic");
  const cfg = buildAliasCfg(alias, owner === "agent" ? original : undefined);
  if (owner === "diagnostic") {
    expect(createWorkspaceAliasMigrationRepair(prompter)).toBeUndefined();
  } else {
    await expect(runWorkspaceRepair(cfg, prompter)).rejects.toThrow();
  }
  expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
  expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
  await expectState(original, true);
  if (owner === "target") {
    await expectState(replacement, true);
  }
});
