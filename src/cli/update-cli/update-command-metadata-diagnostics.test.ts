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
import * as exec from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { expectGitMetadataPreview } from "../update-cli-invocation.test-support.js";
import { printResult } from "./progress.js";
import * as shared from "./shared.js";
import { updateStatusCommand } from "./status.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";
import { updateCommand } from "./update-command.js";

vi.mock("../../version.js", () => ({ VERSION: "2026.9.7" }));

const { fixture } = installFreshUpdateFixture();

async function rejectUpdate(opts: Parameters<typeof updateCommand>[0], name?: string) {
  await expect(updateCommand({ json: true, restart: false, ...opts })).rejects.toMatchObject({
    code: 1,
    ...(name ? { name } : {}),
  });
  return vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0] as UpdateRunResult;
}

function expectContains(output: string, parts: readonly unknown[]) {
  for (const part of parts) {
    expect(output).toContain(part);
  }
}

const failureSteps = (fact: Record<string, unknown>) =>
  expect.arrayContaining([
    expect.objectContaining({ failureFacts: [expect.objectContaining(fact)] }),
  ]);

async function printSummary(result: UpdateRunResult) {
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  await printResult(result, {});
  return log.mock.calls.flat().join("\n");
}

async function readUpdateStatus(manager: "npm" | "bun", latestVersion?: string) {
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);
  vi.spyOn(nodeRuntimeDiagnostics, "collectNodeRuntimeFindings").mockResolvedValue([]);
  vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
    root: fixture.root,
    installKind: "package",
    packageManager: manager,
    ...(latestVersion ? { registry: { latestVersion } } : {}),
  });
  await updateStatusCommand({ json: true });
  return vi.mocked(defaultRuntime.writeJson).mock.lastCall;
}

it.each([
  { manager: "pnpm", name: "default", requests: ["latest"] },
  { manager: "npm", name: "tag", tag: "preview", requests: ["preview"] },
  { manager: "npm", name: "beta", channel: "beta", requests: ["beta", "latest"] },
  { manager: "pnpm", name: "beta fallback", channel: "beta", requests: ["beta", "latest"] },
  { manager: "npm", name: "numeric", tag: "2026.9.4", requests: ["2026.9.4"] },
  { manager: "pnpm", name: "tarball", tag: "./candidate.tgz", requests: [] },
  { manager: "pnpm", name: "moving override", requests: ["latest", "2026.9.4"] },
])("resolves $manager $name with paired metadata and bounded requests", async (entry) => {
  vi.mocked(shared.resolveTargetVersion).mockRestore();
  vi.mocked(updateCheck.resolveNpmChannelTag).mockRestore();
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockRestore();
  const manager = entry.manager === "npm" ? "npm" : "pnpm";
  vi.mocked(shared.resolveGlobalManager).mockResolvedValue(manager);
  vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockResolvedValue({
    manager,
    command: "/selected/npm",
    globalRoot: path.dirname(fixture.root),
    packageRoot: fixture.root,
    ...(manager === "npm"
      ? { npmOwner: { version: "11.10.0", lifecyclePolicy: "unflagged" as const } }
      : {}),
  });
  const env = { ...process.env, NPM_CONFIG_REGISTRY: "https://registry.example.test/" };
  const override = entry.name.includes("override");
  if (override) {
    vi.stubEnv("OPENCLAW_UPDATE_PACKAGE_SPEC", "openclaw@latest");
  }
  vi.mocked(updateGlobal.createGlobalInstallEnv).mockResolvedValue(env);
  const requests: string[] = [];
  const respond = (tag: string) => {
    requests.push(tag);
    const version =
      tag === "beta"
        ? entry.name === "beta fallback"
          ? "2026.9.3-beta.1"
          : "2026.9.5-beta.1"
        : /^\d/.test(tag)
          ? tag
          : "2026.9.4";
    return {
      // A mutable package override can move after target selection.
      version: override && requests.length > 1 ? "2026.9.6" : version,
      engines: { node: tag === "beta" ? ">=24.0.0" : ">=22.0.0" },
      openclaw: { schemaVersions: { state: tag === "beta" ? 18 : 17, agent: 19 } },
    };
  };
  const spawn = vi
    .spyOn(exec, "runCommandWithTimeout")
    .mockImplementation(async (argv, options) => {
      expect(argv.slice(0, 2)).toEqual(["/selected/npm", "view"]);
      expect(typeof options === "number" ? undefined : options.env?.NPM_CONFIG_REGISTRY).toBe(
        env.NPM_CONFIG_REGISTRY,
      );
      return createCommandResult({
        stdout: JSON.stringify(respond(argv[2]!.split("@").at(-1)!)),
      });
    });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return Response.json(respond(url.pathname.split("/").at(-1)!));
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const opts = { tag: entry.tag, channel: entry.channel, dryRun: true, json: true };
    const prepared = await commandRun.prepareUpdateCommand(opts);
    if (!prepared) {
      throw new Error("fixture preparation failed");
    }
    const pending = resolveUpdateCommandTarget(
      opts,
      { triageTarget: { root: fixture.root, env } },
      process.cwd(),
      {
        ...prepared,
        requestedChannel: entry.channel === "beta" ? "beta" : null,
      },
      { enter: vi.fn() },
      5000,
    );
    if (override) {
      await expect(pending).rejects.toMatchObject({
        result: { reason: "target-metadata-preflight" },
      });
    }
    const result = override ? undefined : await pending;
    expect(requests).toEqual(entry.requests);
    expect(spawn).toHaveBeenCalledTimes(manager === "npm" ? entry.requests.length : 0);
    expect(fetch).toHaveBeenCalledTimes(manager === "pnpm" ? entry.requests.length : 0);
    if (override) {
      expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    } else if (entry.name === "tarball") {
      expect(result).toMatchObject({ targetVersion: null, packageInstallSpec: "./candidate.tgz" });
    } else {
      const beta = entry.name === "beta";
      const version = beta ? "2026.9.5-beta.1" : "2026.9.4";
      expect(result).toMatchObject({
        targetVersion: version,
        packageInstallSpec: `openclaw@${version}`,
        packageRuntimeTarget: { version, nodeEngine: beta ? ">=24.0.0" : ">=22.0.0" },
        packageTargetSchemaVersions: { state: beta ? 18 : 17, agent: 19 },
      });
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

function readPrintedFailureReport() {
  expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
  const result = vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0];
  if (!isRecord(result) || typeof result.reportPath !== "string") {
    throw new Error("The failed command did not print its saved report path.");
  }
  return { result, markdown: fs.readFileSync(result.reportPath, "utf8") };
}

it.each([
  { kind: "graph", edge: "cause" },
  { kind: "graph", edge: "aggregate" },
  { kind: "graph", edge: "suppressed" },
  { kind: "graph", edge: "structured" },
  { kind: "metadata", diagnosticWriteFails: false, metadata: null },
  { kind: "metadata", diagnosticWriteFails: true, metadata: null },
  { kind: "metadata", diagnosticWriteFails: false, metadata: "constructor" },
  { kind: "metadata", diagnosticWriteFails: false, metadata: "stack" },
  { kind: "metadata", diagnosticWriteFails: false, metadata: "message" },
] as const)("reports sanitized unexpected exceptions: %j", async (entry) => {
  openOpenClawStateDatabase();
  let error: Error;
  let privateValues: string[];
  if (entry.kind === "graph") {
    const detail =
      "Connection refused token=synthetic-nested-secret at /home/operator/private/npmrc on registry.private.example";
    const codedError = (message: string, code: string) =>
      Object.assign(new Error(message), { code });
    const leaf = Object.assign(
      new Error(detail, { cause: codedError("Socket closed", "ECONNRESET") }),
      {
        name: "PrivateLeafError",
        code: "PRIVATE_LEAF_CODE",
      },
    );
    const cause = {
      aggregate: () => new AggregateError([leaf], "Transport failed"),
      suppressed: () =>
        Object.assign(new Error("Transport failed"), {
          name: "SuppressedError",
          error: leaf,
          suppressed: codedError("Cleanup failed", "PRIVATE_CLEANUP_CODE"),
        }),
      structured: () => ({ message: "Transport failed", name: "PrivateObjectError", cause: leaf }),
      cause: () => new Error("Transport failed", { cause: leaf }),
    }[entry.edge]();
    Object.assign(cause, { code: "PRIVATE_NESTED_CODE" });
    error = Object.assign(new TypeError("Lookup failed", { cause }), {
      name: "PrivateRootError",
      code: "EACCES",
      error: "PRIVATE_NON_CAUSE",
      errors: ["PRIVATE_NON_AGGREGATE"],
      suppressed: "PRIVATE_NOT_SUPPRESSED",
    });
    privateValues = [
      "PRIVATE_",
      "PrivateLeafError",
      "PrivateObjectError",
      "PrivateRootError",
      "synthetic-nested-secret",
      "/home/operator",
      "registry.private.example",
    ];
  } else {
    const detail =
      "Target response was invalid for alice@example.com host=private-gateway on 10.20.30.40 registry.private.example token=synthetic-secret at '/home/operator/private/npmrc'";
    error = new TypeError(entry.diagnosticWriteFails ? "" : detail, { cause: new Error(detail) });
    error.name = "PrivateTenantError";
    error.stack = `${error.name}: ${error.message}\n    at lookup (/home/operator/node_modules/dependency/index.js:2:3)\n    at privatePlugin (/home/operator/private-project/src/private-plugin.ts:4:3)\n    at resolveTargetVersion (${path.resolve("src/cli/update-cli/shared.ts")}:101:9)`;
    if (entry.metadata) {
      Object.defineProperty(error, entry.metadata, {
        get() {
          throw new Error("exception metadata is unavailable");
        },
      });
    }
    if (entry.diagnosticWriteFails) {
      vi.spyOn(
        await import("../../infra/update-run-verification.js"),
        "recordUpdateRunVerificationRecord",
      ).mockImplementationOnce(() => {
        throw Object.assign(new Error("diagnostic ledger is read-only"), {
          code: "SQLITE_READONLY",
        });
      });
    }
    privateValues = [
      "synthetic-secret",
      "/home/operator",
      "registry.private.example",
      "alice",
      "private-gateway",
      "10.20.30.40",
      "private-plugin",
      "PrivateTenantError",
    ];
  }
  vi.spyOn(shared, "resolveTargetVersion").mockRejectedValueOnce(error);
  await rejectUpdate({ tag: "2026.9.2", dryRun: true }, "ExitError");
  const printed = readPrintedFailureReport();
  const message = entry.kind === "graph" ? "Lookup failed" : "Target response was invalid";
  expect(printed.result).toMatchObject({
    status: "error",
    reason: "update-failed",
    steps: failureSteps({
      ...(entry.kind === "graph"
        ? { code: "EACCES" }
        : {
            check: "target-resolution",
            errorName: entry.metadata === "constructor" ? "Error" : "TypeError",
          }),
      message: expect.stringContaining(message),
    }),
  });
  expect(printed.markdown).toContain(message);
  const recordedRun = ledger.listUpdateRuns()[0];
  expect(recordedRun).toBeDefined();
  const report = await prepareUpdateFailureReport({
    attemptId: recordedRun!.runId,
    recordedRun,
    result: { status: "error", mode: "unknown", steps: [], durationMs: 0 },
  });
  if (entry.kind === "graph") {
    expect(printed.markdown).toContain("OpenClaw update failed");
    expectContains(report.body, ["EACCES", "ECONNRESET", "Transport failed", "Connection refused"]);
  } else {
    expectContains(report.body, [
      "Failed phase: target-resolution",
      "Update mode: package",
      "Update target: 2026.9.2",
      "Update action: CLI command: openclaw update",
      "Installation method: npm-global",
      entry.metadata === "constructor" ? "(Error)" : "TypeError",
      "Target response was invalid",
    ]);
    if (!entry.metadata) {
      expect(report.body).toContain("src/cli/update-cli/shared.ts:101:9");
    }
    if (entry.diagnosticWriteFails) {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Update diagnostics could not be recorded"),
      );
    } else {
      expect(report.body).toContain("Rollback outcome: not needed");
    }
  }
  for (const output of [
    report.body,
    JSON.stringify(recordedRun),
    JSON.stringify(printed.result),
    printed.markdown,
  ]) {
    for (const privateText of privateValues) {
      expect(output).not.toContain(privateText);
    }
  }
});

const privateDiagnostic = "registry.internal.example /private/operator/npmrc";
const registryFailure = { version: null, error: privateDiagnostic };
it.each([
  ["registry lookup error", "target-registry-metadata", /registry/i, registryFailure],
  ["existing profile lookup error", "target-registry-metadata", /registry/i, registryFailure],
  ["missing exact version", "target-version-resolution", /version/i, { version: null }],
  ["mismatched exact version", "target-version-resolution", /version/i, { version: "2026.9.1" }],
  [
    "missing target schema metadata",
    "target-schema-metadata",
    /database|schema/i,
    { schemaVersions: undefined },
  ],
  ["unresolved registry dist-tag", "target-registry-dist-tag", /dist-tag|registry/i, {}],
] as const)(
  "explains %s in CLI JSON, summary, and bounded diagnostics without staging a package",
  async (kind, code, detail, overrides) => {
    const existingProfile = kind.startsWith("existing");
    if (existingProfile) {
      openOpenClawStateDatabase();
    }
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      ...overrides,
    });
    if (code === "target-registry-dist-tag") {
      vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
        tag: "latest",
        version: null,
      });
    }

    const result = await rejectUpdate({
      ...(code === "target-registry-dist-tag" ? { channel: "stable" } : { tag: "2026.9.2" }),
      yes: true,
    });
    const metadataFailure = expect.objectContaining({
      name: "target-metadata-preflight",
      exitCode: 1,
      failureFacts: [expect.objectContaining({ code, message: expect.stringMatching(detail) })],
    });
    expect(result).toMatchObject({
      status: "error",
      mode: "npm",
      reason: "target-metadata-preflight",
      failedStep: metadataFailure,
      steps: expect.arrayContaining([metadataFailure]),
    });
    const message = result.failedStep?.failureFacts?.[0]?.message;
    expect(message).toMatch(/openclaw update/);
    expect(await printSummary(result)).toContain(message);

    const report = await prepareUpdateFailureReport({ attemptId: "metadata-admission", result });
    expectContains(report.body, [code, message, "openclaw update"]);
    expect(report.body).toMatch(detail);
    expect(report.body).not.toContain("registry.internal.example");
    expect(report.body).not.toContain("/private/operator/npmrc");
    expect(fs.existsSync(fixture.databasePath)).toBe(existingProfile);
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    if (existingProfile) {
      expect(await readUpdateStatus("npm", "2026.9.2")).toMatchObject([
        {
          lastRun: {
            status: "failed",
            reason: "target-metadata-preflight",
            origin: { nextAction: expect.stringContaining("openclaw update") },
            steps: failureSteps({
              code: "target-registry-metadata",
              message: expect.stringMatching(/registry[\s\S]*openclaw update/i),
            }),
          },
        },
      ]);
    }
  },
);

it("preserves update status after target policy admission failure for an existing profile", async () => {
  openOpenClawStateDatabase();
  vi.spyOn(updateGlobal, "detectGlobalInstallManagerForRoot").mockResolvedValue("bun");
  const result = await rejectUpdate({ tag: "main", yes: true });
  expect(result).toMatchObject({
    status: "error",
    mode: "bun",
    reason: "unsupported-package-target",
  });
  expect(await printSummary(result)).toContain("Update mode: bun");
  const report = await prepareUpdateFailureReport({ attemptId: "target-policy", result });
  expect(report.body).toContain("Update mode: bun");
  expect(await readUpdateStatus("bun")).toMatchObject([
    {
      lastRun: { target: { kind: "package" } },
      update: { packageManager: "bun" },
    },
  ]);
  expect(packageMetadata.fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
});

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
