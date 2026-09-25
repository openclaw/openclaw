import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as nodeRuntimeDiagnostics from "../../commands/node-runtime-diagnostics.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import * as updateGlobal from "../../infra/update-global.js";
import * as ledger from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { expectGitMetadataPreview } from "../update-cli-invocation.test-support.js";
import { printResult } from "./progress.js";
import * as shared from "./shared.js";
import { updateStatusCommand } from "./status.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

function readPrintedFailureReport() {
  expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
  const result = vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0];
  if (!isRecord(result) || typeof result.reportPath !== "string") {
    throw new Error("The failed command did not print its saved report path.");
  }
  return { result, markdown: fs.readFileSync(result.reportPath, "utf8") };
}

it.each(["cause", "aggregate", "suppressed", "structured"] as const)(
  "keeps private exception identities out of reports across %s edges",
  async (edge) => {
    openOpenClawStateDatabase();
    const detail =
      "Connection refused token=synthetic-nested-secret at /home/operator/private/npmrc on registry.private.example";
    const leaf = Object.assign(
      new Error(detail, {
        cause: Object.assign(new Error("Socket closed"), { code: "ECONNRESET" }),
      }),
      {
        name: "PrivateLeafError",
        code: "PRIVATE_LEAF_CODE",
      },
    );
    const cause =
      edge === "aggregate"
        ? new AggregateError([leaf], "Transport failed")
        : edge === "suppressed"
          ? Object.assign(new Error("Transport failed"), {
              name: "SuppressedError",
              error: leaf,
              suppressed: Object.assign(new Error("Cleanup failed"), {
                code: "PRIVATE_CLEANUP_CODE",
              }),
            })
          : edge === "structured"
            ? { message: "Transport failed", name: "PrivateObjectError", cause: leaf }
            : new Error("Transport failed", { cause: leaf });
    Object.assign(cause, { code: "PRIVATE_NESTED_CODE" });
    const error = Object.assign(new TypeError("Lookup failed", { cause }), {
      name: "PrivateRootError",
      code: "EACCES",
      error: "PRIVATE_NON_CAUSE",
      errors: ["PRIVATE_NON_AGGREGATE"],
      suppressed: "PRIVATE_NOT_SUPPRESSED",
    });
    vi.spyOn(shared, "resolveTargetVersion").mockRejectedValueOnce(error);

    await expect(
      updateCommand({ tag: "2026.9.2", dryRun: true, json: true, restart: false }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    const printed = readPrintedFailureReport();
    expect(printed.result).toMatchObject({
      status: "error",
      reason: "update-failed",
      steps: expect.arrayContaining([
        expect.objectContaining({
          failureFacts: [
            expect.objectContaining({
              code: "EACCES",
              message: expect.stringContaining("Lookup failed"),
            }),
          ],
        }),
      ]),
    });
    expect(printed.markdown).toContain("Lookup failed");
    expect(printed.markdown).toContain("OpenClaw update failed");
    const recordedRun = ledger.listUpdateRuns()[0];
    const report = await prepareUpdateFailureReport({
      attemptId: recordedRun!.runId,
      recordedRun,
      result: { status: "error", mode: "unknown", steps: [], durationMs: 0 },
    });
    expect(report.body).toContain("EACCES");
    expect(report.body).toContain("ECONNRESET");
    expect(report.body).toContain("Transport failed");
    expect(report.body).toContain("Connection refused");
    for (const output of [
      report.body,
      JSON.stringify(recordedRun),
      JSON.stringify(printed.result),
      printed.markdown,
    ]) {
      for (const privateText of [
        "PRIVATE_",
        "PrivateLeafError",
        "PrivateObjectError",
        "PrivateRootError",
        "synthetic-nested-secret",
        "/home/operator",
        "registry.private.example",
      ]) {
        expect(output).not.toContain(privateText);
      }
    }
  },
);

it.each([
  { diagnosticWriteFails: false, metadata: null },
  { diagnosticWriteFails: true, metadata: null },
  { diagnosticWriteFails: false, metadata: "constructor" },
  { diagnosticWriteFails: false, metadata: "stack" },
  { diagnosticWriteFails: false, metadata: "message" },
] as const)(
  "reports an unexpected exception with diagnostic write failure=$diagnosticWriteFails, metadata=$metadata",
  async ({ diagnosticWriteFails, metadata }) => {
    openOpenClawStateDatabase();
    const detail =
      "Target response was invalid for alice@example.com host=private-gateway on 10.20.30.40 registry.private.example token=synthetic-secret at '/home/operator/private/npmrc'";
    const error = new TypeError(diagnosticWriteFails ? "" : detail, { cause: new Error(detail) });
    error.name = "PrivateTenantError";
    error.stack = `${error.name}: ${error.message}\n    at lookup (/home/operator/node_modules/dependency/index.js:2:3)\n    at privatePlugin (/home/operator/private-project/src/private-plugin.ts:4:3)\n    at resolveTargetVersion (${path.resolve("src/cli/update-cli/shared.ts")}:101:9)`;
    if (metadata) {
      Object.defineProperty(error, metadata, {
        get() {
          throw new Error("exception metadata is unavailable");
        },
      });
    }
    vi.spyOn(shared, "resolveTargetVersion").mockRejectedValueOnce(error);
    if (diagnosticWriteFails) {
      vi.spyOn(
        await import("../../infra/update-run-verification.js"),
        "recordUpdateRunVerificationRecord",
      ).mockImplementationOnce(() => {
        throw Object.assign(new Error("diagnostic ledger is read-only"), {
          code: "SQLITE_READONLY",
        });
      });
    }

    await expect(
      updateCommand({ tag: "2026.9.2", dryRun: true, json: true, restart: false }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    const printed = readPrintedFailureReport();
    expect(printed.result).toMatchObject({
      status: "error",
      reason: "update-failed",
      steps: expect.arrayContaining([
        expect.objectContaining({
          failureFacts: [
            expect.objectContaining({
              check: "target-resolution",
              errorName: metadata === "constructor" ? "Error" : "TypeError",
              message: expect.stringContaining("Target response was invalid"),
            }),
          ],
        }),
      ]),
    });
    expect(printed.markdown).toContain("Target response was invalid");
    const recordedRun = ledger.listUpdateRuns()[0];
    expect(recordedRun).toBeDefined();
    const report = await prepareUpdateFailureReport({
      attemptId: recordedRun!.runId,
      recordedRun,
      result: { status: "error", mode: "unknown", steps: [], durationMs: 0 },
    });
    expect(report.body).toContain("Failed phase: target-resolution");
    expect(report.body).toContain("Update mode: package");
    expect(report.body).toContain("Update target: 2026.9.2");
    expect(report.body).toContain("Update action: CLI command: openclaw update");
    expect(report.body).toContain("Installation method: npm-global");
    expect(report.body).toContain(metadata === "constructor" ? "(Error)" : "TypeError");
    expect(report.body).toContain("Target response was invalid");
    if (!metadata) {
      expect(report.body).toContain("src/cli/update-cli/shared.ts:101:9");
    }
    if (diagnosticWriteFails) {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Update diagnostics could not be recorded"),
      );
    } else {
      expect(report.body).toContain("Rollback outcome: not needed");
    }
    for (const value of [
      "synthetic-secret",
      "/home/operator",
      "registry.private.example",
      "alice",
      "private-gateway",
      "10.20.30.40",
      "private-plugin",
      "PrivateTenantError",
    ]) {
      expect(report.body).not.toContain(value);
      expect(JSON.stringify(recordedRun)).not.toContain(value);
      expect(JSON.stringify(printed.result)).not.toContain(value);
      expect(printed.markdown).not.toContain(value);
    }
  },
);

const privateDiagnostic = "registry.internal.example /private/operator/npmrc";
const cases = [
  {
    kind: "registry lookup error",
    code: "target-registry-metadata",
    detail: /registry/i,
    metadata: { ...targetMetadata, version: null, error: privateDiagnostic },
  },
  {
    kind: "missing exact version",
    code: "target-version-resolution",
    detail: /version/i,
    metadata: { ...targetMetadata, version: null },
  },
  {
    kind: "mismatched exact version",
    code: "target-version-resolution",
    detail: /version/i,
    metadata: { ...targetMetadata, version: "2026.9.1" },
  },
  {
    kind: "missing target schema metadata",
    code: "target-schema-metadata",
    detail: /database|schema/i,
    metadata: { ...targetMetadata, schemaVersions: undefined },
  },
  {
    kind: "unresolved registry dist-tag",
    code: "target-registry-dist-tag",
    detail: /dist-tag|registry/i,
    metadata: targetMetadata,
  },
];

it.each(cases)(
  "explains $kind in CLI JSON, summary, and bounded diagnostics before creating state",
  async ({ code, detail, metadata }) => {
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue(metadata);
    if (code === "target-registry-dist-tag") {
      vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
        tag: "latest",
        version: null,
      });
    }

    await expect(
      updateCommand({
        ...(code === "target-registry-dist-tag" ? { channel: "stable" } : { tag: "2026.9.2" }),
        yes: true,
        json: true,
        restart: false,
      }),
    ).rejects.toMatchObject({ code: 1 });

    const result = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0] as UpdateRunResult;
    expect(result).toMatchObject({
      status: "error",
      mode: "npm",
      reason: "target-metadata-preflight",
      steps: [
        expect.objectContaining({
          failureFacts: [expect.objectContaining({ code, message: expect.stringMatching(detail) })],
        }),
      ],
    });
    const message = result.steps[0]?.failureFacts?.[0]?.message;
    expect(message).toMatch(/openclaw update/);
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    await printResult(result, {});
    expect(log.mock.calls.flat().join("\n")).toContain(message);

    const report = await prepareUpdateFailureReport({ attemptId: "metadata-admission", result });
    expect(report.body).toContain(code);
    expect(report.body).toContain(message);
    expect(report.body).toMatch(detail);
    expect(report.body).toContain("openclaw update");
    expect(report.body).not.toContain("registry.internal.example");
    expect(report.body).not.toContain("/private/operator/npmrc");
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  },
);

it("keeps metadata failure details in update status JSON for an existing profile", async () => {
  openOpenClawStateDatabase();
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
    ...targetMetadata,
    version: null,
    error: privateDiagnostic,
  });
  await expect(
    updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: false }),
  ).rejects.toMatchObject({ code: 1 });

  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);
  vi.spyOn(nodeRuntimeDiagnostics, "collectNodeRuntimeFindings").mockResolvedValue([]);
  vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
    root: fixture.root,
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.2" },
  });
  await updateStatusCommand({ json: true });
  expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
    expect.objectContaining({
      lastRun: expect.objectContaining({
        status: "failed",
        reason: "target-metadata-preflight",
        origin: expect.objectContaining({ nextAction: expect.stringContaining("openclaw update") }),
        steps: expect.arrayContaining([
          expect.objectContaining({
            failureFacts: [
              expect.objectContaining({
                code: "target-registry-metadata",
                message: expect.stringMatching(/registry[\s\S]*openclaw update/i),
              }),
            ],
          }),
        ]),
      }),
    }),
  );
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
});

it.each(["npm", "pnpm", "bun"] as const)(
  "keeps the %s owner visible when target policy refuses before version lookup",
  async (manager) => {
    openOpenClawStateDatabase();
    vi.spyOn(updateGlobal, "detectGlobalInstallManagerForRoot").mockResolvedValue(manager);
    await expect(
      updateCommand({ tag: "main", json: true, yes: true, restart: false }),
    ).rejects.toMatchObject({ code: 1 });
    const result = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0] as UpdateRunResult;
    expect(result).toMatchObject({
      status: "error",
      mode: manager,
      reason: "unsupported-package-target",
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    await printResult(result, {});
    expect(log.mock.calls.flat().join("\n")).toContain(`Update mode: ${manager}`);
    const report = await prepareUpdateFailureReport({ attemptId: "target-policy", result });
    expect(report.body).toContain(`Update mode: ${manager}`);

    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);
    vi.spyOn(nodeRuntimeDiagnostics, "collectNodeRuntimeFindings").mockResolvedValue([]);
    vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
      root: fixture.root,
      installKind: "package",
      packageManager: manager,
    });
    await updateStatusCommand({ json: true });
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ packageManager: manager }),
        lastRun: expect.objectContaining({ target: expect.objectContaining({ kind: "package" }) }),
      }),
    );
    expect(packageMetadata.fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  },
);

it("previews unreadable Git target metadata with its reason and next step", async () => {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", fixture.root]);
  vi.mocked(commandRun.prepareUpdateCommand).mockRestore();
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);

  await updateCommand({ dryRun: true, json: true, restart: false });

  expectGitMetadataPreview(vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0]);
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
  expect(packageMetadata.fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
});
