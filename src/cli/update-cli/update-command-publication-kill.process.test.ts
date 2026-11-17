import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import {
  createPackageActivationLifetimeFixture,
  mockInertSealedHelper,
} from "../../infra/package-update-activation-lifetime.test-support.js";
import {
  assertNoPendingPackageActivation,
  settlePendingPackageActivation,
} from "../../infra/package-update-activation.js";
import {
  killAtEveryBoundary,
  packageVersion,
  runSwitch,
  type KillSweepChildEnv,
  type KillSweepTools,
} from "../../infra/package-update-kill-sweep.test-support.js";
import { createNpmTarget } from "../../infra/package-update-steps.test-support.js";
import { expectedPathExchangeRoute } from "../../infra/path-exchange.test-support.js";
import * as runtimeWorker from "../../infra/runtime-worker-url.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { registerUpdateCli } from "../update-cli.js";
import * as shared from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { prepareUpdateCommand } from "./update-command-run.js";

const mocks = vi.hoisted(() => ({ root: vi.fn(), finalize: vi.fn() }));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
}));
// mock-isolation: repair's maintenance after settlement would run Doctor and the service owner.
vi.mock("./update-command-finalize.js", () => ({ updateFinalizeCommand: mocks.finalize }));

const fixtures = createPackageActivationLifetimeFixture();
let state: OpenClawTestState;
let root: string;
let env: KillSweepChildEnv;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ root, childGuardEnv: env } = fixtures.setup());
  // A killed updater seals its build's recovery helper, and this process resumes
  // only what its own build sealed: resolve the built helper, not an inert one.
  vi.mocked(runtimeWorker.resolveRuntimeWorkerUrl).mockRestore();
  state = await createOpenClawTestState({
    label: "publication-kill",
    env: { OPENCLAW_UPDATE_RUN_ID: undefined },
  });
  await state.writeConfig({ plugins: { enabled: false } });
  for (const output of ["error", "writeJson", "log"] as const) {
    vi.spyOn(defaultRuntime, output).mockImplementation(() => undefined);
  }
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(createMockGatewayService());
  // Repair's maintenance starts with the admission that the next update repeats.
  mocks.finalize.mockImplementation(async () => {
    assertNoPendingPackageActivation(await mocks.root());
  });
});
afterEach(async () => {
  await state.cleanup();
  await fixtures.cleanup();
});

type Killed = Awaited<ReturnType<typeof runSwitch>>;
const anchored = (name: string) => `lib/node_modules/.openclaw.package-activation/${name}`;
const waiting = `rename ${anchored("candidate")} -> ${anchored("previous")}`;
const displaced = `rename lib/node_modules/openclaw -> ${anchored("previous")}`;
const read = (slot: string) =>
  openPackageActivationJournal(resolvePackageActivationAnchor(slot), { readOnly: true }).read();

/** The start of the next `openclaw update` here: the settlement it tries, then admission. */
function nextUpdate(slot: string, dryRun?: true) {
  mocks.root.mockResolvedValue(slot);
  vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue(
    createNpmTarget(path.dirname(slot)),
  );
  return prepareUpdateCommand({ json: true, dryRun });
}

/** What the next update leaves, and the warning step it hands its run for what it settled. */
async function settleByNextUpdate(killed: Killed) {
  const [step, ...more] = (await nextUpdate(killed.slot)).packageActivationSteps ?? [];
  expect(more).toEqual([]);
  // A second update finds nothing left to settle or to refuse.
  expect((await nextUpdate(killed.slot)).packageActivationSteps).toBeUndefined();
  expect(() => assertNoPendingPackageActivation(killed.slot)).not.toThrow();
  expect(fs.existsSync(resolvePackageActivationAnchor(killed.slot))).toBe(false);
  // The launcher still starts the package the path serves.
  expect(fs.realpathSync(path.join(killed.prefix, "bin", "openclaw"))).toBe(
    path.join(killed.slot, "openclaw.mjs"),
  );
  const warning = step?.warnings?.[0] ?? "";
  return {
    serves: packageVersion(killed.slot),
    settled: warning.match(/package update \S+ \(([a-z-]+)\)/u)?.[1],
    resumed: warning.match(/ is (aborted|published)[:.]/u)?.[1],
  };
}

// One build numbers its boundaries the same way in every run: count them once.
const completed = new Map<KillSweepTools, string[]>();
/** Runs killed right after the boundaries that `pick` selects from a completed run's labels. */
async function killAfter(tools: KillSweepTools, pick: (labels: string[]) => number[]) {
  let labels = completed.get(tools);
  if (!labels) {
    const run = await runSwitch(path.join(root, "complete"), "complete", "journal", { tools, env });
    completed.set(tools, (labels = run.events.flatMap((event) => event.label ?? [])));
  }
  const killed: Killed[] = [];
  for (const index of pick(labels)) {
    const run = path.join(root, `killed-${index + 1}`);
    killed.push(await runSwitch(run, `boundary:${index + 1}`, "journal", { tools, env }));
  }
  return killed;
}
/** What a package manager does to the launcher: a new link with the same target. */
function relinkLauncher(killed: Killed) {
  const launcher = path.join(killed.prefix, "bin", "openclaw");
  const target = fs.readlinkSync(launcher);
  fs.unlinkSync(launcher);
  fs.symlinkSync(target, launcher);
}
/** A run killed with its candidate waiting under `previous` beside the untouched package. */
async function killWithWaitingCandidate() {
  const [killed] = await killAfter(undefined, (labels) => [labels.indexOf(waiting)]);
  expect(read(killed!.slot)).toMatchObject({ phase: "publishing", intent: { kind: "publish" } });
  return killed!;
}
const aborted = { serves: "2026.11.3", settled: "publication-not-started", resumed: "aborted" };
const settledCandidate = "publication-settled-external-change";

describe.skipIf(process.platform === "win32")("next update after a killed publication", () => {
  it.runIf(expectedPathExchangeRoute)(
    "at every boundary: settles the leftover publication itself and proceeds",
    // About forty updaters run one at a time: they share one lease database.
    { timeout: 300_000 },
    () =>
      fixtures.lifetime.run(async () => {
        const { labels, killed } = await killAtEveryBoundary(root, "journal", undefined, env);
        const outcomes: Array<Awaited<ReturnType<typeof settleByNextUpdate>>> = [];
        for (const run of killed) {
          outcomes.push(await settleByNextUpdate(run.state));
        }
        // Before the exchange the previous package stays and the publication ends
        // unstarted; after it the installed candidate is verified and kept.
        const journaled = labels.findIndex((label) => label.startsWith("renameSync "));
        const exchanged = labels.findIndex((label) => label.startsWith("end "));
        expect(outcomes.map(({ serves, settled }) => ({ serves, settled }))).toEqual(
          labels.map((_, index) =>
            index < journaled
              ? { serves: "2026.11.3", settled: undefined }
              : index < exchanged
                ? { serves: "2026.11.3", settled: aborted.settled }
                : { serves: "2026.12.1", settled: settledCandidate },
          ),
        );
        // The waiting candidate is not untouched preparation: resuming it aborts it.
        expect(outcomes[labels.indexOf(waiting)]).toEqual(aborted);
      }),
  );

  it("without an exchange tool: publishes the candidate into a missing installation", () =>
    fixtures.lifetime.run(async () => {
      // The displacement intent, the displaced package, and the publish intent that follows.
      const killed = await killAfter("missing", (labels) => {
        const index = labels.indexOf(displaced);
        return [index - 1, index, index + 1];
      });
      expect(killed.map((run) => fs.existsSync(run.slot))).toEqual([true, false, false]);
      const outcomes = [];
      for (const run of killed) {
        outcomes.push(await settleByNextUpdate(run));
      }
      const published = { serves: "2026.12.1", settled: settledCandidate, resumed: "published" };
      expect(outcomes).toEqual([aborted, published, published]);
    }));

  it.runIf(expectedPathExchangeRoute)(
    "update repair settles the same leftover and records it in run history",
    () =>
      fixtures.lifetime.run(async () => {
        const killed = await killWithWaitingCandidate();
        const operation = read(killed.slot).descriptor.operationId;
        mocks.root.mockResolvedValue(killed.slot);
        const repair = () =>
          runRegisteredCli({
            register: registerUpdateCli,
            argv: ["update", "repair", "--json", "--yes"],
          });

        await repair();
        await repair();

        // Both repairs reached their maintenance, which admission no longer refuses.
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
        expect(mocks.finalize).toHaveBeenCalledTimes(2);
        expect(packageVersion(killed.slot)).toBe("2026.11.3");
        expect(fs.existsSync(resolvePackageActivationAnchor(killed.slot))).toBe(false);
        expect(getUpdateRun(operation)).toMatchObject({
          status: "succeeded",
          reason: "publication-not-started",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "reconcile:settle",
              detail: expect.stringContaining("is aborted: the installed package is kept"),
            }),
          ]),
        });
      }),
  );

  it.runIf(expectedPathExchangeRoute)(
    "a dry run previews the settlement without touching the leftover",
    () =>
      fixtures.lifetime.run(async () => {
        const killed = await killWithWaitingCandidate();
        const before = read(killed.slot);
        const prepared = await nextUpdate(killed.slot, true);
        expect(prepared.packageActivationNotes).toEqual([
          expect.stringMatching(
            /^Would settle .*\(publication-not-started\).*is aborted.*only after it claims the installation/u,
          ),
        ]);
        expect(prepared.packageActivationSteps).toBeUndefined();
        expect(read(killed.slot)).toEqual(before);
        expect(fs.readdirSync(resolvePackageActivationAnchor(killed.slot))).toContain("previous");
      }),
  );

  it.runIf(expectedPathExchangeRoute).each(["removed", "replaced"] as const)(
    "with its lease store %s: refuses, and the reinstall it names retires the operation",
    (loss) =>
      fixtures.lifetime.run(async () => {
        const killed = await killWithWaitingCandidate();
        // A reboot cleared the temporary directory: nothing proves the updater gone.
        const { databasePath } = read(killed.slot).descriptor.authority;
        fs.renameSync(databasePath, `${databasePath}.lost`);
        if (loss === "replaced") {
          fs.copyFileSync(`${databasePath}.lost`, databasePath);
          fs.chmodSync(databasePath, 0o600);
        }
        await expect(nextUpdate(killed.slot)).rejects.toThrow(
          /lease database identity changed.*reinstall openclaw with your package manager/u,
        );
        expect(packageVersion(killed.slot)).toBe("2026.11.3");
        expect(() => assertNoPendingPackageActivation(killed.slot)).toThrow();

        // A package manager installs a new package directory and relinks its launcher.
        fs.renameSync(killed.slot, `${killed.slot}.replaced`);
        fs.cpSync(`${killed.slot}.replaced`, killed.slot, { recursive: true });
        relinkLauncher(killed);
        expect(await settleByNextUpdate(killed)).toMatchObject({
          serves: "2026.11.3",
          settled: "superseded-by-manual-install",
        });
      }),
  );

  it.runIf(expectedPathExchangeRoute)(
    "under a claim its caller already holds: leaves the leftover to its recovery command",
    () =>
      fixtures.lifetime.run(async () => {
        const killed = await killWithWaitingCandidate();
        // Repair's reclaimed claim is not known to be in the recorded lease store.
        await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const owner = (await executor.enter(killed.slot)).assertCurrent;
          await expect(
            settlePendingPackageActivation(killed.slot, undefined, undefined, { owner }),
          ).rejects.toThrow("Package publication is incomplete");
        });
        expect(read(killed.slot).phase).toBe("publishing");
      }),
  );

  // Each control gives the same killed publication one reason not to be resumed.
  const then =
    (change: (killed: Killed) => unknown) => async (killed: Killed, refuses: () => unknown) => {
      await change(killed);
      await refuses();
    };
  const unresumable = "cannot be resumed.*reinstall openclaw with your package manager.*Cause: ";
  it.runIf(expectedPathExchangeRoute).each<{
    name: string;
    refusal: RegExp;
    control: (killed: Killed, refuses: () => unknown) => Promise<unknown>;
  }>([
    {
      name: "another updater holds the installation",
      refusal: /Another update executor owns this installation/u,
      control: (killed, refuses) =>
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          await executor.enter(killed.slot);
          await refuses();
        }),
    },
    {
      name: "the installed package changed",
      refusal: new RegExp(`${unresumable}Package publication object changed`, "u"),
      control: then((killed) =>
        fs.appendFileSync(path.join(killed.slot, "openclaw.mjs"), "// edit\n"),
      ),
    },
    {
      name: "a launcher changed",
      refusal: new RegExp(`${unresumable}Package launcher changed outside`, "u"),
      control: then(relinkLauncher),
    },
    {
      name: "a rollback had begun",
      refusal: /Package restoration is unfinished/u,
      control: then((killed) =>
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(killed.slot);
          const writer = openPackageActivationJournal(resolvePackageActivationAnchor(killed.slot));
          writer.transition(writer.read(), "rollback-in-progress", null, fence.assertCurrent);
        }),
      ),
    },
    {
      name: "another build sealed the recovery helper",
      refusal: /Package publication is incomplete; its original continuation cannot run/u,
      control: then(() => mockInertSealedHelper(root)),
    },
  ])("still refuses when $name", ({ refusal, control }) =>
    fixtures.lifetime.run(async () => {
      const killed = await killWithWaitingCandidate();
      await control(killed, async () => {
        await expect(nextUpdate(killed.slot)).rejects.toThrow(refusal);
      });
      // The refusal leaves the installed package serving and the operation open.
      expect(packageVersion(killed.slot)).toBe("2026.11.3");
      expect(() => assertNoPendingPackageActivation(killed.slot)).toThrow();
    }),
  );
});
