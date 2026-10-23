import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import type { finishUpdate } from "./update-command-post-update.js";
import {
  expectFailureReport,
  expectUpdateFailure,
  finishSuccessfulPackageSwitch,
} from "./update-command-post-update.test-support.js";
import * as rollbackModule from "./update-command-rollback.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

export function registerVerifiedActivationFailureTests({
  tempDirs,
  mocks,
}: {
  tempDirs: { make(prefix: string): string };
  mocks: {
    restartService: Mock<typeof import("./update-command-service.js").maybeRestartService>;
    printResult: Mock;
    markSentinelFailure: Mock;
    writeSentinel: Mock;
  };
}) {
  it("keeps a verified activation successful when restart finalization loses its receipt", async () => {
    mocks.restartService.mockImplementationOnce(async ({ onVerified }) => {
      onVerified?.(Date.now());
      return "restart-health-failed";
    });
    const rollback = vi.spyOn(rollbackModule, "rollbackFailedUpdate");
    await finishSuccessfulPackageSwitch();
    expect(rollback).not.toHaveBeenCalled();
    expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
      status: "ok",
      steps: expect.arrayContaining([
        expect.objectContaining({
          advisory: {
            kind: "recoverable-maintenance",
            message: expect.stringContaining("Restart finalization"),
          },
        }),
      ]),
    });
  });

  it("keeps a verified activation successful when terminal recording fails", async () => {
    mocks.restartService.mockImplementationOnce(async ({ onVerified }) => {
      onVerified?.(Date.now());
      throw new Error("terminal ledger write denied");
    });
    const rollback = vi.spyOn(rollbackModule, "rollbackFailedUpdate");
    await finishSuccessfulPackageSwitch();
    expect(rollback).not.toHaveBeenCalled();
    expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
      status: "ok",
      steps: expect.arrayContaining([
        expect.objectContaining({
          advisory: {
            kind: "recoverable-maintenance",
            message: expect.stringContaining("terminal ledger write denied"),
          },
        }),
      ]),
    });
  });

  it.each([
    { name: "retires the wrapper before persisting and printing success", denied: false },
    {
      name: "recovers and retains the package before reporting failed wrapper retirement",
      denied: true,
    },
    {
      name: "keeps a verified target successful when wrapper retirement fails",
      denied: true,
      verified: true,
    },
  ])("$name", async ({ denied, verified = false }) => {
    const home = tempDirs.make("openclaw-finalize-wrapper-");
    const previousRoot = path.join(home, "old-root");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${previousRoot}/dist/entry.js "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", path.dirname(wrapper));
    const unlink = vi.spyOn(fs, "unlink");
    if (denied) {
      unlink.mockRejectedValueOnce(new Error("unlink denied"));
    }
    const rollback = vi
      .spyOn(rollbackModule, "rollbackFailedUpdate")
      .mockImplementationOnce(async ({ result }) => ({ result, rolledBack: false }));
    const retained = {
      name: "package backup retained",
      command: "openclaw update",
      cwd: previousRoot,
      durationMs: 0,
      exitCode: 0,
      stderrTail: "Retained previous package for recovery.",
    };
    const complete = vi.fn<NonNullable<FinishUpdateParams["packageTransaction"]>["complete"]>(
      async ({ activationVerified }) => (activationVerified ? undefined : retained),
    );
    if (verified) {
      mocks.restartService.mockImplementationOnce(async ({ onVerified }) => {
        onVerified?.(Date.now());
        return "ok";
      });
    }
    const finishing = finishSuccessfulPackageSwitch(
      {
        previousRoot,
        packageRoot: path.join(home, "package"),
        ...(verified ? { restartEnvironment: process.env } : {}),
      },
      {
        installKindChanged: true,
        packageTransaction: { backupRoot: previousRoot, rollback: vi.fn(), complete },
      },
    );
    if (denied && !verified) {
      await expectUpdateFailure(finishing, "wrapper-retirement-failed", {
        detail: expect.stringContaining("unlink denied"),
      });
      expect(rollback).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        { activationVerified: false },
        expect.any(Function),
      );
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
        status: "error",
        steps: expect.arrayContaining([retained]),
      });
      expectFailureReport(mocks.printResult, "wrapper-retirement-failed");
      expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "wrapper-retirement-failed" }),
      );
      return;
    }
    await finishing;
    expect(rollback).not.toHaveBeenCalled();
    if (verified) {
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
        status: "ok",
        steps: expect.arrayContaining([
          expect.objectContaining({
            advisory: {
              kind: "recoverable-maintenance",
              message: expect.stringContaining("unlink denied"),
            },
          }),
        ]),
      });
      expect(mocks.markSentinelFailure).not.toHaveBeenCalled();
    }
    expect(mocks.writeSentinel).toHaveBeenCalledTimes(2);
    expect(unlink.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeSentinel.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.writeSentinel.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.printResult.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
}
