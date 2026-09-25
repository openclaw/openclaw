import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { renderGatewayServiceStartHints } from "../cli/daemon-cli/shared.js";
import { formatCliFailureLines } from "../cli/failure-output.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import * as tmpRoot from "../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { readConfiguredParsedLogTail } from "../logging/log-tail.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import type { OpenClawDatabaseSchemaPreflight } from "../state/openclaw-database-preflight.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { deleteTestEnvValue } from "../test-utils/env.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { VERSION } from "../version.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { guardUpdateDoctorSchemaUpgrade } from "./doctor-update-schema-guard.js";

vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../cli/update-cli/update-command-service-maintenance.js")
  >()),
  maybeStopManagedServiceBeforeMutableUpdate: vi.fn(),
}));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));
// These cases exercise service/schema refusal after update admission, not ledger admission.
vi.mock("../infra/update-run-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-reader.js")>()),
  createUpdateRunAdmissionReader: () => () => [],
}));

const activationReason =
  "The update parent must stop the managed Gateway before Doctor maintenance; Doctor left the service unchanged.";
const maintenanceSuffix =
  " Stop the Gateway service and other OpenClaw processes using this state, then run openclaw doctor --fix from an independent shell.";
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  const directory = fs.realpathSync(tempDirs.make("doctor-refusal-handoff-"));
  const binding = createManagedHandoffTestBinding(directory);
  vi.spyOn(tmpRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(directory);
  vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} ${binding.nodeOption}`.trim());
  binding.assertPath(resolveManagedUpdateLeaseDatabasePath());
  vi.clearAllMocks();
  mockSystemAccountHome();
});
afterEach(async () => {
  await flushLogger();
  closeOpenClawStateDatabaseForTest();
  setLoggerOverride(null);
  resetLogger();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type History =
  | "detached"
  | "main-rebase"
  | "expired"
  | "missing"
  | "ambiguous"
  | "same-tree"
  | "earlier-rebase"
  | "stale"
  | "npm";

function createCheckout(root: string, history: History) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  if (history === "npm") {
    return { previous: "", candidate: "" };
  }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        `core.hooksPath=${path.join(root, "disabled-hooks")}`,
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Update Fixture",
          GIT_AUTHOR_EMAIL: "update-fixture@example.test",
          GIT_COMMITTER_NAME: "Update Fixture",
          GIT_COMMITTER_EMAIL: "update-fixture@example.test",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          ...(history === "stale" && args[0] === "checkout"
            ? { GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" }
            : {}),
        },
      },
    ).trim();
  git("init", "-b", "installed");
  fs.writeFileSync(path.join(root, "generation"), "previous");
  git("add", ".");
  git("commit", "-m", "Previous installed source");
  const previous = git("rev-parse", "HEAD");
  const makeCommit = (generation: string, parent: string) => {
    fs.writeFileSync(path.join(root, "generation"), generation);
    git("add", ".");
    return git("commit-tree", git("write-tree"), "-p", parent, "-m", generation);
  };
  const intermediate = makeCommit("intermediate", previous);
  const candidate = makeCommit(history === "same-tree" ? "previous" : "candidate", intermediate);
  // Prepare candidate objects without adding a checkout to the driver's reflog sequence.
  git("read-tree", "--reset", "-u", previous);
  if (history === "main-rebase") {
    git("branch", "main", intermediate);
    git("checkout", "main");
    git("rebase", candidate);
  } else if (history === "earlier-rebase") {
    git("branch", "main", previous);
    git("checkout", "main");
    git("rebase", intermediate);
    git("rebase", candidate);
  } else if (history === "missing") {
    git("update-ref", "HEAD", candidate);
    git("read-tree", "--reset", "-u", candidate);
  } else {
    if (history === "ambiguous" || history === "expired") {
      git("checkout", "--detach", intermediate);
    }
    git("checkout", "--detach", candidate);
    if (history === "expired") {
      // Expiry can remove a destination record without rewriting the next checkout's source.
      git("reflog", "delete", "HEAD@{1}");
    }
  }
  return { previous: history === "expired" ? intermediate : previous, candidate };
}

async function withFixture(
  history: History,
  run: (fixture: {
    state: OpenClawTestState;
    root: string;
    previous: string;
    candidate: string;
    schemas: OpenClawDatabaseSchemaPreflight;
  }) => Promise<void>,
  running = true,
) {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      layout: "home",
      env: {
        ...buildUpdateDoctorEnv({ allowGatewayServiceRepair: true, allowGatewayActivation: false }),
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_CONTAINER_HINT: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_LAUNCHD_LABEL: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_LOG_LEVEL: "warn",
        OPENCLAW_DEBUG: undefined,
      },
    },
    async (state) => {
      // The enclosing test-state scope owns environment restoration.
      deleteTestEnvValue("OPENCLAW_HOME");
      const root = state.path("checkout");
      const commits = createCheckout(root, history);
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
      vi.mocked(maybeStopManagedServiceBeforeMutableUpdate).mockResolvedValue({
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running,
        offline: false,
        serviceUpdateVerdict: {
          kind: "owned",
          root,
          fingerprint: "fixture-service",
          refreshDefinition: false,
        },
      });
      const schemas: OpenClawDatabaseSchemaPreflight = {
        incompatible: [],
        indeterminate: [],
        pendingMigrations: [
          {
            kind: "agent",
            path: state.path("agent.sqlite"),
            agentId: "main",
            foundVersion: 1,
            supportedVersion: 2,
          },
        ],
      };
      createUpdateRun({
        runId: "3752a66b-275f-4fe0-b43b-1c9a7e6fe7ca",
        trigger: "cli",
        before: { version: "2026.9.2" },
      });
      closeOpenClawStateDatabaseForTest();
      await flushLogger();
      setLoggerOverride({
        level: "warn",
        consoleLevel: "silent",
        file: state.path("warnings.log"),
      });
      try {
        await run({ state, root, schemas, ...commits });
      } finally {
        await flushLogger();
        setLoggerOverride(null);
        resetLogger();
      }
    },
  );
}

async function refusalError(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected Doctor to refuse before repair");
}

async function warnings(): Promise<string> {
  await flushLogger();
  const tail = await readConfiguredParsedLogTail();
  return tail.lines.map((line) => line.message).join("\n");
}

function expectRecovery(output: string, root: string, previous: string) {
  const quotedRoot = quote(root);
  for (const fact of [
    "The previous source is intact in Git.",
    `Previous source commit: ${previous}`,
    `git -C ${quotedRoot} checkout ${previous}`,
    "pnpm install",
    "pnpm build",
    "Once the upgrade succeeds, subsequent updates validate before activation.",
    ...renderGatewayServiceStartHints(),
  ]) {
    expect(output).toContain(fact);
  }
  expect(output).not.toContain("pnpm install --");
}

describe("Doctor refusal recovery under the released Git update driver", () => {
  it.each([
    { platform: "darwin", running: true },
    { platform: "darwin", running: false },
    { platform: "linux", running: true },
    { platform: "win32", running: true },
  ] as const)(
    "names the managed-service stop command when the Gateway is not offline on $platform (running=$running)",
    async ({ platform, running }) => {
      await withFixture(
        "npm",
        async ({ root }) => {
          mockProcessPlatform(platform);
          const error = await refusalError(
            beginDoctorMaintenance({
              root,
              options: { repair: true, nonInteractive: true },
              runtime,
            }),
          );
          expect(error.message).toContain("openclaw gateway stop");
          expect(error.message).toContain("openclaw update repair");
          expect(error.message).toContain("If the stop command already returned successfully");
          expect(error.message).toContain("managed-service shutdown did not complete");
          if (platform === "darwin") {
            expect(error.message).toContain(
              `launchctl bootout gui/${process.getuid?.() ?? 501}/ai.openclaw.gateway`,
            );
          }
          expect(maybeStopManagedServiceBeforeMutableUpdate).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ phase: "inspect" }),
          );
        },
        running,
      );
    },
  );

  it.each(["detached", "main-rebase", "expired"] as const)(
    "preserves the schema refusal and records recovery for %s switching",
    async (history) => {
      await withFixture(history, async ({ root, previous, state, schemas }) => {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const before = fs.readFileSync(databasePath);
        const error = await refusalError(guardUpdateDoctorSchemaUpgrade({ schemas, runtime }));
        // The schema bootstrap uses root CLI formatting before the 9.2 parent's ten-line tail.
        const message = formatCliFailureLines({
          title: "CLI failed",
          error,
          argv: ["node", "openclaw", "doctor", "--non-interactive", "--fix"],
          env: process.env,
        })
          .join("\n")
          .trimEnd()
          .split("\n")
          .slice(-10)
          .join("\n");
        const reason =
          "[openclaw] Reason: Doctor refused update-time schema repair driven by OpenClaw 2026.9.2:";
        expect(message).toContain(reason);
        expect(message.indexOf(reason)).toBeLessThan(
          message.indexOf("The previous source is intact in Git."),
        );
        expectRecovery(message, root, previous);
        const logged = await warnings();
        expect(logged).toContain("Doctor refused update-time schema repair");
        expectRecovery(logged, root, previous);
        expect(fs.readFileSync(databasePath)).toEqual(before);
      });
    },
  );

  it("preserves activation ownership and records recovery without touching the service", async () => {
    await withFixture("detached", async ({ root, previous }) => {
      // Exercise the released parent's display boundary, not only the full child error.
      const message = (
        await refusalError(
          beginDoctorMaintenance({
            root,
            options: { repair: true, nonInteractive: true },
            runtime,
          }),
        )
      ).message
        .trimEnd()
        .split("\n")
        .slice(-10)
        .join("\n");
      expect(
        message.startsWith(`Doctor could not enter maintenance. Error: ${activationReason}`),
      ).toBe(true);
      expectRecovery(message, root, previous);
      const logged = await warnings();
      expect(logged).toContain(activationReason);
      expectRecovery(logged, root, previous);
      expect(maybeStopManagedServiceBeforeMutableUpdate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ phase: "inspect" }),
      );
    });
  });

  it("retains npm schema recovery and omits direct Doctor recovery for an update child", async () => {
    await withFixture("npm", async ({ root, schemas, state }) => {
      const expectedSchema =
        "Doctor refused update-time schema repair driven by OpenClaw 2026.9.2: this updater reopens the ledger with old code after migration, and version publication could not be deferred safely. " +
        `agent database ${state.path("agent.sqlite")}: on-disk schema 1, this build's schema 2. ` +
        "The blocked schema change was not applied. Let the updater restore the previous package, then update manually: " +
        `openclaw gateway stop && npm install -g openclaw@${VERSION} --allow-scripts=openclaw && openclaw doctor --fix && openclaw gateway start. ` +
        `Use the package manager that owns this install (pnpm: pnpm add -g --allow-build=openclaw openclaw@${VERSION}; Bun: bun add -g --trust openclaw@${VERSION}). On npm 11.15 and earlier, omit --allow-scripts=openclaw.`;
      expect(
        (await refusalError(guardUpdateDoctorSchemaUpgrade({ schemas, runtime }))).message,
      ).toBe(expectedSchema);
      const maintenanceError = await refusalError(
        beginDoctorMaintenance({
          root,
          options: { repair: true, nonInteractive: true },
          runtime,
        }),
      );
      expect(maintenanceError.message).toContain(
        `Doctor could not enter maintenance. Error: ${activationReason}`,
      );
      expect(maintenanceError.message).not.toContain(maintenanceSuffix);
      expect(await warnings()).toBe("");
    });
  });

  it("keeps non-driver schema admission and maintenance refusal unchanged", async () => {
    await withFixture("detached", async ({ root, schemas }) => {
      deleteTestEnvValue("OPENCLAW_UPDATE_IN_PROGRESS");
      await expect(guardUpdateDoctorSchemaUpgrade({ schemas, runtime })).resolves.toBeUndefined();
      vi.mocked(maybeStopManagedServiceBeforeMutableUpdate).mockResolvedValue({
        stopped: false,
        inspected: false,
        runtimeInspected: false,
        running: false,
        blockMessage: "Synthetic service inspection unavailable.",
      });
      expect(
        (
          await refusalError(
            beginDoctorMaintenance({
              root,
              options: { repair: true, nonInteractive: true },
              runtime,
            }),
          )
        ).message,
      ).toBe(
        `Doctor could not enter maintenance. Error: Synthetic service inspection unavailable.${maintenanceSuffix}`,
      );
      expect(await warnings()).toBe("");
    });
  });

  it.each(["missing", "ambiguous", "same-tree", "earlier-rebase", "stale"] as const)(
    "does not guess a previous commit with %s history",
    async (history) => {
      await withFixture(history, async ({ root, previous, candidate, schemas }) => {
        const message = (await refusalError(guardUpdateDoctorSchemaUpgrade({ schemas, runtime })))
          .message;
        for (const output of [message, await warnings()]) {
          expect(output).toContain("The previous commit could not be determined; inspect");
          expect(output).toContain(`git -C ${quote(root)} reflog`);
          expect(output).not.toContain(`checkout ${previous}`);
          expect(output).not.toContain(`checkout ${candidate}`);
          expect(output).not.toContain("Previous source commit:");
          expect(output).not.toContain(" checkout ");
        }
      });
    },
  );
});

it("preserves Git recovery instead of accepting its package-style early markers", async () => {
  await withFixture("detached", async ({ root, previous, schemas }) => {
    Object.assign(
      process.env,
      buildUpdateDoctorEnv({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
        serviceRepairPolicy: "external",
        deferConfiguredPluginInstallRepair: true,
      }),
    );
    recordUpdateRunStep("3752a66b-275f-4fe0-b43b-1c9a7e6fe7ca", {
      step: "openclaw doctor",
      status: "in_progress",
    });
    const error = await refusalError(guardUpdateDoctorSchemaUpgrade({ schemas, runtime }));
    expect(error).toMatchObject({ code: "update-schema-bump-unfenced" });
    expectRecovery(error.message, root, previous);
  });
});
