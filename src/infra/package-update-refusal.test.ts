import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { privatePackageActivationIdentity } from "./package-update-activation-paths.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmUpdateOptions,
  packageUpdateStepResult,
  stagedNpmPrefix,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import { normalizeFallbackFailureReason } from "./update-runner-command.js";

describe.skipIf(process.platform === "win32")("package-swap refusal reports", () => {
  it.each([
    ["journal mode", "package-recovery-permissions-unsafe"],
    ["journal links", "package-recovery-permissions-unsafe"],
    ["lease file", "managed-handoff-lease-identity-changed"],
    ["lease parent", "managed-handoff-lease-identity-changed"],
    ["lease path", "managed-handoff-lease-identity-changed"],
    ["untyped permissions", "global-install-failed"],
    ["untyped lease", "global-install-failed"],
  ] as const)("identifies %s without publishing private diagnostics", async (failure, reason) => {
    await withTestDir({ prefix: "openclaw-refusal-report-" }, async (temporaryDir) => {
      const base = await fs.realpath(temporaryDir);
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const privateFile = path.join(base, "private-customer.example");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(privateFile, "retained evidence", { mode: 0o600 });
      const identity = captureManagedUpdateLeaseDatabaseIdentity(privateFile);
      if (failure === "journal mode") {
        await fs.chmod(privateFile, 0o640);
      } else if (failure === "journal links") {
        await fs.link(privateFile, path.join(base, "retained-link"));
      }
      const result = await runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot),
        runStep: async ({ name, argv, cwd }) => {
          const prefix = stagedNpmPrefix(argv);
          await writePackageRoot(path.join(prefix, "lib", "node_modules", "openclaw"), "2.0.0");
          return packageUpdateStepResult({ name, argv, cwd });
        },
        onTransaction: () => {
          if (failure.startsWith("journal")) {
            privatePackageActivationIdentity(privateFile, "journal");
          } else if (failure === "lease path") {
            createManagedHandoffLeaseDatabase(path.join(base, "other.sqlite"), identity);
          } else if (failure === "lease file" || failure === "lease parent") {
            const field = failure === "lease file" ? "databaseIdentity" : "parentIdentity";
            captureManagedUpdateLeaseDatabaseIdentity(privateFile, { ...identity, [field]: "0:0" });
          } else {
            throw new Error(
              failure === "untyped permissions"
                ? "Package publication recovery permissions are unsafe"
                : `managed handoff lease database identity changed at ${privateFile}`,
            );
          }
        },
      });
      expect(result.failedStep?.name).toBe("package-swap");
      const actualReason = result.reason ?? normalizeFallbackFailureReason(result.failedStep!.name);
      expect(actualReason).toBe(reason);
      const report = await prepareUpdateFailureReport(
        {
          attemptId: "package-refusal",
          result: {
            status: "error",
            mode: "npm",
            durationMs: 1,
            reason: actualReason,
            steps: result.steps,
            recovery: result.recovery,
          },
        },
        { env: {}, stateDir: base },
      );
      expect(report.body).toContain(`Reason code: ${reason}`);
      if (!failure.startsWith("untyped")) {
        expect(report.body).toContain(`Failing check package-swap (${reason})\n`);
      } else {
        expect(report.body).toContain("[redacted-diagnostic]");
      }
      expect(report.body).not.toContain("private-customer");
      expect(report.body).not.toContain(base);
      expect(report.body).not.toContain(result.failedStep!.stderrTail!);
      expect(await fs.readFile(privateFile, "utf8")).toBe("retained evidence");
      expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
    });
  });
});
