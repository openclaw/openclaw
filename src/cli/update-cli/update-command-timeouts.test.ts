import { expect, it, vi } from "vitest";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
import * as shared from "./shared.js";
import * as execution from "./update-command-execution.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as commandRun from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

installFreshUpdateFixture();

it.each(
  ["cli", "campaign"].flatMap((trigger) =>
    [undefined, "3600"].map((timeout) => ({ trigger, timeout })),
  ),
)(
  "keeps $trigger step defaults separate from explicit timeout $timeout",
  async ({ trigger, timeout }) => {
    const record = createUpdateRun({ trigger: trigger === "campaign" ? "campaign" : "cli" });
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", record.runId);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    const prepare = vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation()!;
    vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (opts) => ({
      ...(await prepare(opts)),
      timeoutMs: shared.parseUpdateTimeoutMs(opts.timeout),
    }));
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue("2026.9.4");
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      target: "2026.9.4",
      version: "2026.9.4",
      nodeEngine: null,
      schemaVersions: { state: 17, agent: 20 },
    });
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: { nodeRunner: process.execPath },
    });
    const execute = vi
      .spyOn(execution, "executeMutableUpdate")
      .mockImplementation(async (params) => {
        finishUpdateRun(record.runId, { status: "succeeded" }, { env: params.opts.run?.env });
        return null;
      });

    await updateCommand({ tag: "2026.9.4", yes: true, json: true, restart: false, timeout });

    const stepTimeoutMs =
      timeout === undefined ? (trigger === "campaign" ? 45 : 30) * 60_000 : 3_600_000;
    expect(servicePlan.resolvePackageRuntimePreflight).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: stepTimeoutMs }),
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        timeoutMs: timeout === undefined ? undefined : 3_600_000,
        updateStepTimeoutMs: stepTimeoutMs,
      }),
    );
  },
);
