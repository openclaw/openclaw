import { describe, expect, it, vi } from "vitest";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { defaultRuntime } from "../../runtime.js";
import * as executorOwner from "./update-command-executor.js";
import { allowPackageRuntime } from "./update-command-fresh-preview.test-support.js";
import {
  expectFreshStatePreserved,
  expectNoFreshCalls,
  installFreshUpdateFixture,
} from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
const withExecutor = executorOwner.withUpdateCommandExecutor;
const updateOptions = { yes: true, json: true, restart: false };
const metadataRefusal = { version: null, nodeEngine: null, error: "fixture registry unavailable" };

describe("fresh update terminal reporting", () => {
  it("publishes one metadata refusal for a preview without entering a mutation lease", async () => {
    allowPackageRuntime();
    const doctor = vi.spyOn(packageUpdate, "runPackageUpdateDoctor");
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", "  1c5a25f3-f46a-408b-a87f-a0f0d1f80ee7  ");
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValueOnce(metadataRefusal);
    const observations: string[] = [];
    const enter = vi.fn();
    vi.spyOn(executorOwner, "withUpdateCommandExecutor").mockImplementationOnce(
      (runId, operation, options) =>
        withExecutor(
          runId,
          (executor) => {
            const originalEnter = executor.enter.bind(executor);
            vi.spyOn(executor, "enter").mockImplementation((...args) => {
              enter();
              return originalEnter(...args);
            });
            return operation(executor);
          },
          options,
        ),
    );
    vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
      observations.push(createManagedHandoffLeaseStore().read(fixture.root).kind);
    });
    const failure = await updateCommand({ ...updateOptions, dryRun: true }).catch(
      (error: unknown) => error,
    );

    expect(observations).toEqual(["absent"]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    const output = vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0];
    expect(output).toMatchObject({ status: "error", reason: "target-metadata-preflight" });
    expect(enter).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(UpdateCommandFailure);
    expect(failure).toMatchObject({
      exitCode: 1,
      result: {
        status: "error",
        reason: "target-metadata-preflight",
        failedStep: { failureFacts: [{ code: "target-registry-metadata" }] },
      },
    });
    expectFreshStatePreserved(fixture);
    expectNoFreshCalls(doctor);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("registry unavailable"),
    );
  });
});
