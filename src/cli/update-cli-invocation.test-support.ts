import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { expect, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import {
  createGitRuntimeTransaction,
  prepareGitRuntimePromotion,
} from "../infra/update-runner-git-runtime.js";
import { updateGitCheckout } from "../infra/update-runner-git.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { ExitError } from "../runtime.js";
import type { UpdateCommandOptions } from "./update-cli/shared.js";

const including = (object: Record<string, unknown>) =>
  expect.arrayContaining([expect.objectContaining(object)]);

export function expectGitMetadataPreview(result: unknown): void {
  expect(result).toMatchObject({
    dryRun: true,
    mode: "git",
    notes: expect.arrayContaining([
      expect.stringMatching(/Git target manifest or revision[\s\S]*retry openclaw update/),
    ]),
    failures: including({
      reason: "target-metadata-preflight",
      message: expect.stringMatching(/Git[\s\S]*openclaw update/),
      failureFacts: [
        expect.objectContaining({
          code: "target-git-metadata",
          message: expect.stringContaining("a dry-run does not fetch missing objects"),
        }),
      ],
    }),
  });
}

export function expectPluginCapabilityRetryNotice(
  output: unknown,
  {
    mode,
    source,
    pluginId,
  }: { mode: "update" | "finalize"; source: "installed" | "bridge"; pluginId: string },
): void {
  const { run, ...result } = expectDefined(output, "JSON update result") as UpdateRunResult & {
    run?: UpdateRunRecord;
  };
  if (mode === "update") {
    expect(run?.runId).toBe(result.runId);
    expect(run?.status).not.toBe("failed");
  }
  expect(result).toMatchObject({
    status: mode === "finalize" ? "warning" : "ok",
    ...(mode === "finalize" ? { restart: false } : {}),
    postUpdate: {
      plugins: {
        status: "warning",
        warnings: including({
          pluginId,
          message: expect.stringContaining(`openclaw plugins update ${pluginId}`),
        }),
        npm: {
          outcomes: [
            expect.objectContaining({
              pluginId,
              status: "error",
              code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
            }),
          ],
        },
      },
    },
  });
  if (source === "bridge") {
    expect(result.postUpdate?.plugins?.sync?.errors).toEqual([
      'Failed to update consent-fixture: Operator review token changed.\nBundled relocation did not install the replacement plugin payload; resolve the error above, then run "openclaw update repair".',
    ]);
  }
}

export function expectUpdateFailureReport(
  failure: unknown,
  cause: Error,
  output: unknown,
  runId: string | undefined,
): void {
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    name: "UpdateCommandFailure",
    message: expect.stringContaining(cause.message),
    exitCode: 1,
    result: { status: "error", reason: "update-failed" },
  });
  expect(collectNestedErrorCandidates(failure)).toContain(cause);
  expect(output).toMatchObject({
    status: "error",
    reason: "update-failed",
    runId,
    reportPath: expect.any(String),
  });
  expect(JSON.stringify(output)).toContain(cause.message);
}

export function expectDelegatedPluginDoctorInput(input: unknown): void {
  expect(JSON.parse(String(input))).toMatchObject({
    root: process.cwd(),
    runId: expect.any(String),
    executor: expect.any(Object),
    configInputHash: expect.any(String),
    repair: true,
    yes: true,
    workspaceSuggestions: false,
  });
}

export function expectSelectorTriageFailure(
  error: unknown,
  diagnostic: unknown,
  cause: Error,
  reported: boolean,
): void {
  if (!reported) {
    expect(error).toBe(cause);
    expect(diagnostic).toEqual({ error: cause.message });
    return;
  }
  expect(error).toEqual(new ExitError(1));
  expect(diagnostic).toMatchObject({
    error: expect.stringContaining(cause.message),
    result: {
      status: "error",
      reason: "update-failed",
      steps: including({
        exitCode: 1,
        failureFacts: [expect.objectContaining({ message: cause.message })],
      }),
    },
  });
}

export async function invokeUpdateCli(opts: UpdateCommandOptions) {
  const { registerUpdateCli } = await import("./update-cli.js");
  const program = new Command();
  registerUpdateCli(program);
  const args = [
    "update",
    ...(["yes", "json", "dryRun", "acceptCapabilities"] as const).flatMap((key) =>
      opts[key] ? [`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`] : [],
    ),
    ...(opts.restart === false ? ["--no-restart"] : []),
    ...(["channel", "tag", "timeout", "admission"] as const).flatMap((key) =>
      opts[key] === undefined ? [] : [`--${key}`, opts[key]],
    ),
  ];
  await program.parseAsync(args, { from: "user" });
}

export const devTargetRefusalCases = [
  ["malformed tracked", "openclaw-dev-target:v1:not+base64url", false, false],
  ["unknown version tracked", "openclaw-dev-target:v2:hostile-ref", false, false],
  ["unknown namespace tracked", "other-dev-target:v1:hostile-ref", false, false],
  ["malformed inferred", "openclaw-dev-target:v1:not+base64url", true, false],
  ["malformed inferred JSON", "openclaw-dev-target:v1:not+base64url", true, true],
] as const;

export const makeOkUpdateResult = (overrides: Partial<UpdateRunResult> = {}): UpdateRunResult => ({
  status: "ok",
  mode: "git",
  steps: [],
  durationMs: 100,
  after: { version: "1.0.0" },
  ...overrides,
});

export async function retainFixtureGitRuntime(
  gitRoot: string,
  onTransaction: NonNullable<Parameters<typeof updateGitCheckout>[0]["opts"]["onTransaction"]>,
) {
  const root = await fs.realpath(gitRoot);
  const originalManifest = await fs.readFile(path.join(root, "package.json"));
  const originalRuntime = await fs.stat(path.join(root, "dist")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  const artifacts = path.join(root, ".artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  const scope = await fs.mkdtemp(path.join(artifacts, "update-runtime-fixture-"));
  const candidate = path.join(scope, "candidate");
  await fs.mkdir(candidate);
  try {
    if (originalRuntime) {
      await fs.cp(path.join(root, "dist"), path.join(candidate, "dist"), { recursive: true });
    } else {
      await fs.mkdir(path.join(candidate, "dist"));
      await fs.writeFile(path.join(candidate, "dist", "index.js"), "export {};\n");
    }
    const promotion = await prepareGitRuntimePromotion(
      root,
      candidate,
      async () => ({ code: 0, stdout: "dist/\0", stderr: "" }),
      5_000,
      scope,
    );
    await promotion.activate();
    await onTransaction(
      createGitRuntimeTransaction({
        root,
        promotion,
        assertRollbackSafe: async () => {
          expect(await fs.realpath(gitRoot)).toBe(root);
          expect(await fs.readFile(path.join(root, "package.json"))).toEqual(originalManifest);
        },
        restoreRuntime: async (assertCurrent) => {
          await promotion.restore(assertCurrent);
          if (originalRuntime) {
            expect(await fs.stat(path.join(root, "dist"))).toMatchObject({
              dev: originalRuntime.dev,
              ino: originalRuntime.ino,
            });
          } else {
            await expect(fs.stat(path.join(root, "dist"))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
          return {
            name: "git-runtime-rollback",
            command: "restore retained fixture runtime",
            cwd: root,
            durationMs: 0,
            exitCode: 0,
            activePackageRoot: root,
          };
        },
      }),
    );
  } finally {
    await fs.rm(scope, { recursive: true, force: true });
  }
}

export function createGitUpdateAfterMutationFixture(
  result = makeOkUpdateResult({ mode: "git" }),
  reinspect = false,
) {
  const mutationAdmitted = vi.fn();
  const run: typeof updateGitCheckout = async ({ opts, gitRoot }) => {
    const target = { version: result.after?.version ?? undefined };
    await opts.inspectGitTarget(target);
    await opts.prepareGitExposure?.(
      expectDefined(result.root, "candidate checkout"),
      expectDefined(result.after?.sha ?? undefined, "candidate commit"),
      undefined,
    );
    await opts.validateCandidate(result.root ?? gitRoot);
    await expectDefined(opts.beforeGitMutation, "Git mutation admission")({});
    mutationAdmitted();
    if (opts.onTransaction) {
      await retainFixtureGitRuntime(gitRoot, opts.onTransaction);
    }
    if (reinspect) {
      await opts.inspectGitTarget(target);
    }
    return result;
  };
  return { run, mutationAdmitted };
}

export const mockGitUpdateAfterMutation = (
  result = makeOkUpdateResult({ mode: "git" }),
  reinspect = false,
) => {
  const fixture = createGitUpdateAfterMutationFixture(result, reinspect);
  vi.mocked(updateGitCheckout).mockImplementationOnce(fixture.run);
  return fixture.mutationAdmitted;
};
