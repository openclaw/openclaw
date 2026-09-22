import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cliBackends from "../../../agents/cli-backends.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { makeCronJob } from "../../../cron/delivery.test-helpers.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
  saveCronJobsStore,
} from "../../../cron/store.js";
import { resolveDoctorContributionHealthChecks } from "../../../flows/doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "../../../flows/doctor-health-contributions.test-support.js";
import { runDoctorLintChecks } from "../../../flows/doctor-lint-flow.js";
import * as processExec from "../../../process/exec.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createDoctorPrompter } from "../../doctor-prompter.js";

const { note } = vi.hoisted(() => ({ note: vi.fn() }));
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note }));

let state: OpenClawTestState;
const cfg: OpenClawConfig = {
  agents: {
    entries: { main: { model: "native-cli/example" } },
  },
};
const projectNativeToolAuthority = vi.fn(() => ["read", "exec"]);

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "doctor-native-cap" });
  vi.spyOn(processExec, "runExec").mockResolvedValue({ stdout: "", stderr: "" });
  vi.spyOn(cliBackends, "resolveCliBackendConfig").mockImplementation((provider) => ({
    id: provider,
    config: { command: "fixture-cli" },
    bundleMcp: true,
    ...(provider === "native-cli" ? { projectNativeToolAuthority } : {}),
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  note.mockClear();
  projectNativeToolAuthority.mockClear();
  await state.cleanup();
});

async function runRegisteredCronCheck(config: OpenClawConfig) {
  const context = createDoctorHealthFlowContext({ cfg: config, configPath: state.configPath });
  const result = await runDoctorLintChecks(
    { mode: "lint", runtime: context.runtime, cfg: config, configPath: state.configPath },
    {
      checks: await resolveDoctorContributionHealthChecks(),
      onlyIds: ["core/doctor/legacy-cron-store"],
      includeAllChecks: true,
    },
  );
  expect(result.checksRun).toBe(1);
  return result.findings;
}

describe("Doctor cron native-tool advisory", () => {
  it.each([false, true])(
    "doctor:legacy-cron dispatch reports incomplete defaults without rewriting tools (repair=%s)",
    async (repair) => {
      const jobs = [
        { id: "old-default", toolsAllow: ["message"], toolsAllowIsDefault: true },
        { id: "empty-default", toolsAllow: [], toolsAllowIsDefault: true },
        { id: "explicit", toolsAllow: ["message"], toolsAllowIsDefault: false },
        { id: "unmarked", toolsAllow: ["message"] },
        { id: "native-read", toolsAllow: ["read"], toolsAllowIsDefault: true },
        { id: "native-search", toolsAllow: ["web_search"], toolsAllowIsDefault: true },
        {
          id: "no-native-backend",
          model: "other-cli/example",
          toolsAllow: ["message"],
          toolsAllowIsDefault: true,
        },
      ].map(({ id, ...payload }) =>
        makeCronJob({
          id,
          name: id,
          agentId: "main",
          enabled: false,
          payload: { kind: "agentTurn", message: "Check the local report.", ...payload },
        }),
      );
      const storePath = resolveCronJobsStorePath();
      await saveCronJobsStore(storePath, { version: 1, jobs });
      const before = (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs;

      const context = createDoctorHealthFlowContext({
        cfg,
        configPath: state.configPath,
        options: { repair, nonInteractive: true },
      });
      context.prompter = createDoctorPrompter({
        runtime: context.runtime,
        options: context.options,
      });
      const contributions = resolveDoctorHealthContributions().filter(
        (contribution) => contribution.id === "doctor:legacy-cron",
      );
      expect(contributions).toHaveLength(1);
      await runDoctorHealthContributionList(context, contributions);
      const advisories = note.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("no native file, command, or web tools"));
      expect(advisories).toHaveLength(2);
      expect(advisories[0]).toContain('Automation "old-default"');
      expect(advisories[1]).toContain('Automation "empty-default"');
      expect(advisories[0]).toContain('openclaw cron edit <id> --tools "<complete list>" --json');
      expect(advisories[0]).toContain("deliberately restricted jobs can be left as is");
      expect(advisories[0]).toContain("Doctor --fix does not add missing native tools");
      expect(projectNativeToolAuthority).not.toHaveBeenCalled();
      const after = (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs;
      expect(after.map((job) => job.payload)).toEqual(before.map((job) => job.payload));

      const findings = await runRegisteredCronCheck(cfg);
      const nativeFindings = findings.filter(
        (finding) => finding.requirement === "cron-native-tool-cap-review",
      );
      expect(nativeFindings.map((finding) => finding.message).toSorted()).toEqual(
        advisories.toSorted(),
      );
      expect(nativeFindings.every((finding) => finding.fixHint?.includes("will not add"))).toBe(
        true,
      );
    },
  );

  it("core/doctor/legacy-cron-store dispatch uses the owning agent's model alias", async () => {
    const storePath = resolveCronJobsStorePath();
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [
        makeCronJob({
          agentId: "research",
          payload: {
            kind: "agentTurn",
            message: "Check the report.",
            model: "reviewer",
            toolsAllow: ["message"],
            toolsAllowIsDefault: true,
          },
        }),
      ],
    });
    const findings = await runRegisteredCronCheck({
      agents: {
        entries: {
          main: { model: "other-cli/example" },
          research: {
            model: "other-cli/example",
            models: { "native-cli/example": { alias: "reviewer" } },
          },
        },
      },
    });
    expect(
      findings.filter((finding) => finding.requirement === "cron-native-tool-cap-review"),
    ).toHaveLength(1);
  });
});
