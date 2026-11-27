import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginProcessRuntimeEntrypoints } from "../plugins/process-runtime.test-support.js";
import { loadPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import * as gatewayOwner from "./gateway-owner-lease.js";
import { writeGitReleaseLauncher } from "./git-release-launcher.js";
import {
  GIT_RELEASE_TRIAL,
  gitReleaseSlot,
  resolveGitReleaseEntrypointForLauncher,
  resolveGitReleaseLauncherForEntrypoint,
  prepareGitReleaseLayout,
} from "./git-release-paths.js";
import {
  createGitReleaseDirs,
  publishGitRelease,
  settleGitReleaseTrial,
  waitForGitReleaseSuccessor,
} from "./git-release.js";
import { listPackageReleases } from "./package-release-retention.js";
import { readPackageReleaseSlotSync } from "./package-release-slot-path.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "./restart-budget.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function release(prefix: string, version: string, entry: string) {
  const root = (await createGitReleaseDirs(prefix)).releaseRoot;
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
  await fs.writeFile(path.join(root, "dist", "index.js"), entry);
  return root;
}

async function publishFixture(prefix: string, version: string, entry: string, trial: boolean) {
  const releaseRoot = await release(prefix, version, entry);
  await publishGitRelease({ prefix, releaseRoot, trial });
}

async function publishFailingTrial(prefix: string, previousTrial: boolean) {
  await publishFixture(prefix, "1.0.0", 'console.log("old");\n', previousTrial);
  await publishFixture(prefix, "2.0.0", 'throw new Error("boot");\n', true);
}

async function setup() {
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-")));
  roots.push(stateDir);
  return { stateDir, prefix: path.join(stateDir, "git-install") };
}

const startGateway = (prefix: string, env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [path.join(prefix, "openclaw-launcher.mjs"), "gateway"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

// The launcher and the service units it names run under Node; Bun runs neither.
describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "git releases",
  () => {
    describe("waiting for a cooperative restart", () => {
      const incumbent = {
        owner: "before",
        host: os.hostname(),
        pid: 1234,
        startedAt: 1,
        port: 18789,
        mode: "supervised",
        supervisor: { kind: "launchd", name: "test-gateway" },
        state: "live",
        expired: false,
      } as const;
      const successor = { ...incumbent, owner: "after", pid: 2345 };
      const unchanged = { status: "unverified", incumbentPid: incumbent.pid };
      const waitForHandoff = (allowGitReleaseRestartSignal = true) =>
        waitForGitReleaseSuccessor({
          serviceEnv: {},
          gatewayPort: incumbent.port,
          allowGitReleaseRestartSignal,
        });
      const spyOnLease = () => vi.spyOn(gatewayOwner, "readGatewayOwnerLease");
      const spyOnSignal = () => vi.spyOn(process, "kill");
      const unreadable = () => {
        throw new Error("owner lease temporarily unavailable");
      };
      beforeEach(() => void vi.useFakeTimers());
      afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
      });
      it("does not verify the incumbent while the restart is deferred for active work", async () => {
        const owner = spyOnLease().mockReturnValue(incumbent);
        const start = performance.now();
        owner.mockReturnValueOnce({ ...incumbent, state: "unknown", startedAt: null });
        owner.mockImplementation(() =>
          performance.now() - start === 35_000 ? { ...incumbent, state: "unknown" } : incumbent,
        );
        const kill = spyOnSignal().mockImplementation(() => {
          expect(performance.now() - start).toBeGreaterThan(35_000);
          owner.mockReturnValue({ ...incumbent, externalRestartReceipt: "new-receipt" });
          setTimeout(() => {
            owner.mockReturnValue(undefined);
            setTimeout(() => owner.mockReturnValue(successor), 2_000);
          }, resolveGatewayRestartDeferralTimeoutMs());
          return true;
        });
        const verified = vi.fn();
        const wait = waitForHandoff().then((result) => verified(result, owner()?.pid));
        await vi.advanceTimersByTimeAsync(90_000);
        expect(kill).toHaveBeenCalledExactlyOnceWith(incumbent.pid, "SIGUSR2");
        expect(verified).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(resolveGatewayRestartDeferralTimeoutMs());
        await wait;
        expect(verified).toHaveBeenCalledExactlyOnceWith({ status: "changed" }, 2345);
      });
      it.each([undefined, "earlier-receipt"])(
        "does not extend the wait on delivery alone (prior receipt: %s)",
        async (prior) => {
          spyOnLease().mockReturnValue({ ...incumbent, externalRestartReceipt: prior });
          const kill = spyOnSignal().mockReturnValue(true);
          const wait = waitForHandoff();
          await vi.advanceTimersByTimeAsync(90_000);
          await expect(wait).resolves.toEqual(unchanged);
          expect(kill).toHaveBeenCalledExactlyOnceWith(incumbent.pid, "SIGUSR2");
        },
      );
      it.each([
        ["ESRCH", true],
        ["ESRCH", false],
        ["EPERM", true],
        ["EPERM", false],
      ] as const)(
        "keeps observing until the original deadline after SIGUSR2 gets %s (successor arrives: %s)",
        async (code, successorArrives) => {
          const owner = spyOnLease().mockReturnValue(incumbent);
          const kill = spyOnSignal().mockImplementation(() => {
            throw Object.assign(new Error("signal not delivered"), { code });
          });
          const finished = vi.fn();
          void waitForHandoff().then(finished);
          await vi.advanceTimersByTimeAsync(35_000);
          // A still-visible lease cannot justify retrying or acknowledging an undelivered signal.
          owner.mockReturnValue({ ...incumbent, externalRestartReceipt: "another-request" });
          await vi.advanceTimersByTimeAsync(54_000);
          expect(finished).not.toHaveBeenCalled();
          if (successorArrives) {
            owner.mockReturnValue(successor);
          }
          await vi.advanceTimersByTimeAsync(1_000);
          expect(finished).toHaveBeenCalledExactlyOnceWith(
            successorArrives ? { status: "changed" } : unchanged,
          );
          expect(kill).toHaveBeenCalledExactlyOnceWith(incumbent.pid, "SIGUSR2");
        },
      );
      it("does not signal or spend the deferral budget when external restarts are disabled", async () => {
        const owner = spyOnLease().mockReturnValue(incumbent);
        const kill = spyOnSignal().mockReturnValue(true);
        const wait = waitForHandoff(false);
        await vi.advanceTimersByTimeAsync(50_000);
        owner.mockReturnValue({ ...incumbent, owner: "watcher-successor", pid: 2345 });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(wait).resolves.toEqual({ status: "changed" });
        expect(kill).not.toHaveBeenCalled();
      });
      it.each(["listeningAt", "heartbeatAt"] as const)(
        "recovers an incumbent whose %s predates an unreadable first poll",
        async (timestamp) => {
          const started = Date.now();
          const owner = spyOnLease().mockImplementation(unreadable);
          const kill = spyOnSignal().mockReturnValue(true);
          const wait = waitForHandoff();
          await vi.advanceTimersByTimeAsync(10_000);
          owner.mockReturnValue({
            ...incumbent,
            heartbeatAt: Date.now(),
            listeningAt: Date.now(),
            [timestamp]: started - 1,
          });
          await vi.advanceTimersByTimeAsync(25_000);
          expect(kill).toHaveBeenCalledExactlyOnceWith(incumbent.pid, "SIGUSR2");
          owner.mockReturnValue(successor);
          await vi.advanceTimersByTimeAsync(1_000);
          await expect(wait).resolves.toEqual({ status: "changed" });
        },
      );
      it.each([
        ["unreadable", unreadable],
        ["new owner", (start: number) => ({ ...incumbent, listeningAt: start + 1 })],
        ["same millisecond", (start: number) => ({ ...incumbent, heartbeatAt: start })],
        [
          "wrong port",
          (start: number) => ({ ...incumbent, port: incumbent.port + 1, listeningAt: start - 1 }),
        ],
        ["no timestamps", () => incumbent],
      ] as const)(
        "observes only to the original deadline if the initial incumbent cannot be established: %s",
        async (_scenario, read) => {
          const started = Date.now();
          spyOnLease()
            .mockImplementation(() => read(started))
            .mockImplementationOnce(unreadable);
          const kill = spyOnSignal().mockReturnValue(true);
          const finished = vi.fn();
          void waitForHandoff().then(finished);
          await vi.advanceTimersByTimeAsync(89_000);
          expect(finished).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(finished).toHaveBeenCalledExactlyOnceWith({ status: "unverified" });
          expect(kill).not.toHaveBeenCalled();
        },
      );
      it("honors command-scope cancellation while the initial owner lease remains unreadable", async () => {
        spyOnLease().mockImplementation(unreadable);
        const kill = spyOnSignal().mockReturnValue(true);
        const controller = new AbortController();
        const wait = withCommandProcessScope(() => waitForHandoff(), controller.signal);
        await vi.advanceTimersByTimeAsync(1_000);
        controller.abort();
        await expect(wait).rejects.toThrow();
        expect(kill).not.toHaveBeenCalled();
      });
    });

    it.each([false, true])(
      "loads a bundled plugin contract from the selected release (under node_modules: %s) (#201874)",
      async (underNodeModules) => {
        const { prefix } = await setup();
        const releaseRoot = (await createGitReleaseDirs(prefix)).releaseRoot;
        const root = underNodeModules
          ? path.join(path.dirname(releaseRoot), "lib", "node_modules", "openclaw")
          : releaseRoot;
        // A release is a worktree of the checkout: bundled plugins keep their TypeScript sources.
        await fs.cp(
          fileURLToPath(new URL("../../extensions/deepseek", import.meta.url)),
          path.join(root, "extensions", "deepseek"),
          { recursive: true, filter: (source) => path.basename(source) !== "node_modules" },
        );
        if (underNodeModules) {
          const builtRoot = path.join(root, "dist", "extensions", "deepseek");
          await fs.mkdir(builtRoot, { recursive: true });
          // The root build emits public artifacts here, outside the plugin's source root.
          await fs.writeFile(
            path.join(builtRoot, "web-search-contract-api.js"),
            'exports.createDeepSeekWebSearchProvider = () => ({ id: "built-deepseek" });\n',
          );
        }
        await publishGitRelease({ prefix, releaseRoot: root, trial: false });

        // The Gateway names its root by the release link, as the MCP web-search request does.
        const pluginRoot = path.join(gitReleaseSlot(prefix), "extensions", "deepseek");
        if (underNodeModules) {
          // A built Gateway runs on plain Node, without Vitest's tsx hook.
          const loaderUrl = resolveRuntimeWorkerUrl(
            pluginProcessRuntimeEntrypoints.publicSurfaceLoader,
          ).href;
          const result = spawnNodeEvalSync(
            `
            import { loadPluginPublicArtifactModuleSync } from ${JSON.stringify(loaderUrl)};
            const contract = loadPluginPublicArtifactModuleSync({
              pluginRoot: ${JSON.stringify(pluginRoot)},
              artifactBasename: "web-search-contract-api.js",
              origin: "bundled",
            });
            console.log(contract.createDeepSeekWebSearchProvider().id);
          `,
            { env: { ...process.env, NODE_OPTIONS: "" } },
          );
          expect(result.stderr).toBe("");
          expect(result.status).toBe(0);
          expect(result.stdout.trim()).toBe("built-deepseek");
          return;
        }
        const contract = loadPluginPublicArtifactModuleSync<{
          createDeepSeekWebSearchProvider: () => { id: string };
        }>({
          pluginRoot,
          artifactBasename: "web-search-contract-api.js",
          origin: "bundled",
        });
        expect(contract.createDeepSeekWebSearchProvider).toBeTypeOf("function");
        expect(contract.createDeepSeekWebSearchProvider().id).toBe("deepseek");
      },
    );

    it("keeps listing releases built under node_modules after the link moves out", async () => {
      const { prefix } = await setup();
      // A release built before #201874 keeps its package at lib/node_modules/openclaw.
      const old = path.join(prefix, "releases", "git-old", "lib", "node_modules", "openclaw");
      await fs.mkdir(old, { recursive: true });
      await fs.writeFile(
        path.join(old, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      );
      await publishFixture(prefix, "2.0.0", "", false);

      const releases = await listPackageReleases(gitReleaseSlot(prefix));
      expect(releases.map(({ id, version, selected }) => ({ id, version, selected }))).toEqual(
        expect.arrayContaining([
          { id: "git-old", version: "1.0.0", selected: false },
          expect.objectContaining({ version: "2.0.0", selected: true }),
        ]),
      );
    });

    it.each([false, true])(
      "rolls back a broken Windows trial from one task supervisor start (pending: %s)",
      async (pending) => {
        const { prefix } = await setup();
        // The previous release's supervisor, as shipped before the launcher global: it restarts a
        // crashed child up to three times and starts each child with process.argv[1].
        const supervisorSource = `
          const { spawnSync } = require("node:child_process");
          if (process.argv.includes("--task-supervisor")) {
            for (let attempt = 0; attempt < 4; attempt++) {
              const child = spawnSync(process.execPath, [process.argv[1], "gateway", "--task-supervisor-child=70000"], { encoding: "utf8" });
              process.stdout.write(child.stdout);
              process.stderr.write(child.stderr);
              if (child.status === 0) break;
            }
          } else {
            console.log("old gateway");
          }
        `;
        const good = await release(prefix, "1.0.0", supervisorSource);
        await publishGitRelease({ prefix, releaseRoot: good, trial: true });
        // pending: a --no-restart update leaves the link on the previous release.
        await publishGitRelease({
          prefix,
          releaseRoot: await release(prefix, "2.0.0", 'throw new Error("boot");\n'),
          trial: true,
          pending,
        });

        // Task Scheduler does not restart a task whose action exits with an error, so one start of
        // the task supervisor must try the release and switch back by itself.
        const supervisor = spawnSync(
          process.execPath,
          [path.join(prefix, "openclaw-launcher.mjs"), "gateway", "--task-supervisor"],
          { encoding: "utf8" },
        );

        // A pending release is selected without the two-start fallback, so its children only fail.
        expect(supervisor.stderr).toContain(
          pending ? "boot" : "failed to start twice; switched back",
        );
        if (!pending) {
          expect(supervisor.stdout).toContain("old gateway");
          expect(await fs.realpath(gitReleaseSlot(prefix))).toBe(await fs.realpath(good));
        }
      },
    );

    it("switches back and restores upgraded state after two failed trial starts", async () => {
      const { stateDir, prefix } = await setup();
      const good = await release(prefix, "1.0.0", 'console.log("old " + process.argv[1]);\n');
      await publishGitRelease({ prefix, releaseRoot: good, trial: true });
      const bad = await release(prefix, "2.0.0", 'throw new Error("boot");\n');
      const db = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(db), { recursive: true });
      await publishGitRelease({ prefix, releaseRoot: bad, trial: true });
      // The new release's boot upgraded state by copy and swap before crashing:
      // the WAL had a predecessor, the trial created SHM and seal files from scratch.
      await fs.writeFile(`${db}.pre-2.0.0`, "old schema");
      await fs.writeFile(`${db}-wal.pre-2.0.0`, "old wal");
      await fs.writeFile(db, "new schema");
      await fs.writeFile(`${db}-wal`, "new wal");
      await fs.writeFile(`${db}-shm`, "new shm");
      await fs.writeFile(`${db}.seal`, "new seal");
      // A finished part of its upgrade added a file with no predecessor.
      const created = path.join(stateDir, "client", "credentials.sqlite");
      await fs.mkdir(path.dirname(created), { recursive: true });
      await fs.writeFile(created, "new only");
      await fs.writeFile(
        path.join(stateDir, ".upgraded-2.0.0.json"),
        JSON.stringify({ appVersion: "2.0.0", ops: [{ kind: "add", live: created }] }),
      );
      // It crashed partway through its durable plan: one file added, one still pending.
      const plan = path.join(stateDir, ".upgrade-2.0.0-1-1");
      const added = path.join(stateDir, "state", "added.sqlite");
      const pending = path.join(stateDir, "state", "pending.sqlite");
      await fs.mkdir(plan);
      await fs.writeFile(added, "new only");
      await fs.writeFile(pending, "old pending");
      await fs.writeFile(path.join(plan, "pending.next"), "new pending");
      await fs.writeFile(
        path.join(plan, "plan.json"),
        JSON.stringify({
          appVersion: "2.0.0",
          ops: [
            { kind: "add", live: added, next: path.join(plan, "added.next") },
            { kind: "replace", live: pending, next: path.join(plan, "pending.next") },
          ],
        }),
      );

      expect(startGateway(prefix).status).not.toBe(0);
      expect(startGateway(prefix).status).not.toBe(0);
      const third = startGateway(prefix);

      expect(third.status).toBe(0);
      expect(third.stdout).toContain(
        `old ${path.join(gitReleaseSlot(prefix), "dist", "index.js")}`,
      );
      expect(third.stderr).toContain("failed to start twice");
      expect(await fs.readFile(db, "utf8")).toBe("old schema");
      expect(await fs.readFile(`${db}-wal`, "utf8")).toBe("old wal");
      await expect(fs.access(`${db}-shm`)).rejects.toThrow();
      await expect(fs.access(`${db}.seal`)).rejects.toThrow();
      await expect(fs.access(path.join(prefix, "releases", GIT_RELEASE_TRIAL))).rejects.toThrow();
      // The previous release finds no plan to finish and none of the trial's files.
      await expect(fs.access(plan)).rejects.toThrow();
      await expect(fs.access(added)).rejects.toThrow();
      await expect(fs.access(created)).rejects.toThrow();
      expect(await fs.readFile(pending, "utf8")).toBe("old pending");
    });

    it("resumes an interrupted rollback before the link moves", async () => {
      const { stateDir, prefix } = await setup();
      await publishFailingTrial(prefix, true);
      const db = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(db, { recursive: true });
      await fs.writeFile(path.join(db, "blocker"), "");
      await fs.writeFile(`${db}.pre-2.0.0`, "old schema");
      // The predecessor's WAL holds committed transactions of its own.
      await fs.writeFile(`${db}-wal.pre-2.0.0`, "old wal");
      await fs.writeFile(`${db}-wal`, "new wal");
      const slot = gitReleaseSlot(prefix);
      const target = await fs.readlink(slot);

      startGateway(prefix);
      startGateway(prefix);
      // Restoration fails: the trial still names its release, so the next start retries.
      expect(startGateway(prefix).status).not.toBe(0);
      expect(await fs.readlink(slot)).toBe(target);
      await fs.rm(db, { recursive: true });
      const resumed = startGateway(prefix);

      expect(resumed.stdout).toContain("old");
      expect(await fs.readFile(db, "utf8")).toBe("old schema");
      expect(await fs.readFile(`${db}-wal`, "utf8")).toBe("old wal");
      expect(await fs.readlink(slot)).not.toBe(target);
    });

    it("keeps a family's restored WAL when a rollback resumes after partial progress", async () => {
      const { stateDir, prefix } = await setup();
      await publishFailingTrial(prefix, true);
      const db = path.join(stateDir, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(db), { recursive: true });
      // The previous rollback recorded the family, restored the WAL, then stopped.
      await fs.writeFile(`${db}-wal`, "old wal");
      await fs.writeFile(`${db}.pre-2.0.0`, "old schema");
      await fs.writeFile(db, "new schema");
      const trialFile = path.join(prefix, "releases", GIT_RELEASE_TRIAL);
      const trial = JSON.parse(await fs.readFile(trialFile, "utf8"));
      await fs.writeFile(
        trialFile,
        JSON.stringify({
          ...trial,
          attempts: 2,
          restoring: [{ suffix: ".pre-2.0.0", files: [`${db}-wal`, db] }],
        }),
      );

      expect(startGateway(prefix).stdout).toContain("old");
      expect(await fs.readFile(db, "utf8")).toBe("old schema");
      expect(await fs.readFile(`${db}-wal`, "utf8")).toBe("old wal");
    });

    it("restores a symlinked config outside the state directory named with ~", async () => {
      const { prefix } = await setup();
      // Outside the state directory, so the state scan cannot find it.
      const home = (await setup()).stateDir;
      const config = path.join(home, "cfg", "openclaw.json");
      await fs.mkdir(path.dirname(config), { recursive: true });
      // The backup of a symlinked config is a symlink; its dotfile predates the trial.
      await fs.writeFile(path.join(home, "dotfile.json"), "old config");
      await new Promise((resolve) => {
        setTimeout(resolve, 1100);
      });
      vi.stubEnv("HOME", home);
      vi.stubEnv("OPENCLAW_HOME", home);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", "~/cfg/openclaw.json");
      try {
        await publishFailingTrial(prefix, false);
      } finally {
        vi.unstubAllEnvs();
      }
      await fs.symlink(path.join(home, "dotfile.json"), `${config}.pre-2.0.0`);
      await fs.writeFile(config, "new config");
      const env = { HOME: home, OPENCLAW_HOME: home, OPENCLAW_CONFIG_PATH: "~/cfg/openclaw.json" };

      startGateway(prefix, env);
      startGateway(prefix, env);

      expect(startGateway(prefix, env).stdout).toContain("old");
      expect(await fs.readFile(config, "utf8")).toBe("old config");
    });

    it("leaves a --no-restart release to the next service start", async () => {
      const { prefix } = await setup();
      const current = await release(prefix, "1.0.0", 'console.log("current");\n');
      await publishGitRelease({ prefix, releaseRoot: current, trial: false });
      const slot = gitReleaseSlot(prefix);
      const serving = await fs.readlink(slot);
      const next = await release(prefix, "2.0.0", 'console.log("next");\n');
      await publishGitRelease({ prefix, releaseRoot: next, trial: true, pending: true });

      // The serving Gateway's link is untouched until the operator restarts it.
      expect(await fs.readlink(slot)).toBe(serving);
      expect(startGateway(prefix).stdout).toContain("next");
      expect(await fs.readlink(slot)).not.toBe(serving);
      // No updater settles an operator start, so later starts never count toward a switch-back.
      await expect(fs.access(path.join(prefix, "releases", GIT_RELEASE_TRIAL))).rejects.toThrow();
      startGateway(prefix);
      expect(startGateway(prefix).stdout).toContain("next");
    });

    it("keeps the applied plan and the trial when removing an addition fails", async () => {
      const { stateDir, prefix } = await setup();
      await publishFailingTrial(prefix, false);
      // An addition that cannot be removed (here a non-empty directory).
      const stuck = path.join(stateDir, "client", "credentials.sqlite");
      await fs.mkdir(stuck, { recursive: true });
      await fs.writeFile(path.join(stuck, "blocker"), "");
      const record = path.join(stateDir, ".upgraded-2.0.0.json");
      await fs.writeFile(
        record,
        JSON.stringify({ appVersion: "2.0.0", ops: [{ kind: "add", live: stuck }] }),
      );
      const slot = gitReleaseSlot(prefix);
      const target = await fs.readlink(slot);

      startGateway(prefix);
      startGateway(prefix);
      expect(startGateway(prefix).status).not.toBe(0);

      await expect(fs.access(record)).resolves.toBeUndefined();
      expect(await fs.readlink(slot)).toBe(target);
      await fs.rm(stuck, { recursive: true });
      expect(startGateway(prefix).stdout).toContain("old");
    });

    it("stops counting once the trial release reports ready", async () => {
      const { prefix } = await setup();
      await publishFixture(prefix, "1.0.0", "", false);
      await publishFixture(prefix, "2.0.0", 'console.log("new");\n', true);
      const trial = path.join(prefix, "releases", GIT_RELEASE_TRIAL);
      expect(JSON.parse(await fs.readFile(trial, "utf8"))).toMatchObject({ version: "2.0.0" });

      expect(startGateway(prefix).stdout).toContain("new");
      await settleGitReleaseTrial(gitReleaseSlot(prefix));

      await expect(fs.access(trial)).rejects.toThrow();
    });

    it.each(["openclaw", "lib/node_modules/openclaw"])(
      "keeps the service on the release launcher for %s",
      async (relativeSlot) => {
        const { stateDir, prefix } = await setup();
        const slot = path.join(prefix, relativeSlot);
        const root = path.join(prefix, "releases", "git-fixture", relativeSlot);
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await fs.writeFile(path.join(root, "dist", "index.js"), "");
        await fs.mkdir(path.dirname(slot), { recursive: true });
        await fs.symlink(path.relative(path.dirname(slot), root), slot);
        const entry = path.join(slot, "dist", "index.js");
        const launcher = path.join(prefix, "openclaw-launcher.mjs");
        // A legacy install retains the launcher written by its older updater.
        await fs.writeFile(launcher, "");
        const { resolveGatewayProgramArguments } = await import("../daemon/program-args.js");
        const service = await resolveGatewayProgramArguments({
          env: { OPENCLAW_STATE_DIR: stateDir },
          cliEntrypoint: { planned: entry },
          runtime: "node",
          runtimePath: process.execPath,
          port: 18789,
        });
        expect(service.programArguments.slice(-4)).toEqual([
          launcher,
          "gateway",
          "--port",
          "18789",
        ]);
        expect(resolveGitReleaseLauncherForEntrypoint(entry)).toBe(launcher);
        expect(resolveGitReleaseEntrypointForLauncher(launcher)).toBe(entry);
        expect(resolveGitReleaseLauncherForEntrypoint("/opt/openclaw/dist/index.js")).toBeNull();
        if (relativeSlot === "openclaw") {
          expect(await writeGitReleaseLauncher(prefix)).toBe(launcher);
        }
      },
    );

    it("does not use another package's release as the Git launcher", async () => {
      const { prefix } = await setup();
      const slot = path.join(prefix, "other");
      const root = path.join(prefix, "releases", "git-fixture", "other");
      await fs.mkdir(root, { recursive: true });
      await fs.symlink(path.relative(prefix, root), slot);

      expect(
        resolveGitReleaseLauncherForEntrypoint(path.join(slot, "dist", "index.js")),
      ).toBeNull();
    });

    it("keeps a service unit that names the launcher across release switches", async () => {
      const { inspectManagedGatewayServiceBeforeUpdate } =
        await import("../cli/update-cli/update-command-service-plan.js");
      const { prefix } = await setup();
      await publishFixture(prefix, "1.0.0", "", false);
      const launcher = path.join(prefix, "openclaw-launcher.mjs");
      const verdict = await inspectManagedGatewayServiceBeforeUpdate({
        root: gitReleaseSlot(prefix),
        state: {
          installed: true,
          loadState: { status: "loaded" },
          running: true,
          env: {},
          command: { programArguments: [process.execPath, launcher, "gateway", "--port", "1"] },
          runtime: { status: "running", systemd: { managerUid: 1001 } },
        },
      });

      expect(verdict).toMatchObject({ kind: "owned", refreshDefinition: false });
    });

    // A Git conversion keeps the service `gateway install` wrote for the checkout; the
    // checkout's entry forwards to the launcher, and Doctor runs from the release.
    it.each([
      ["forwards dist/index.js to this launcher", "owned"],
      ["forwards openclaw.mjs to this launcher", "owned"],
      ["is a linked worktree forwarding to this launcher", "owned"],
      ["has no forwarding marker", "foreign"],
      ["forwards to a missing launcher", "foreign"],
      ["forwards to another state directory's launcher", "foreign"],
      ["lacks the forwarder module", "foreign"],
      ["is a package, not a checkout", "foreign"],
    ] as const)("classifies a checkout service whose tree %s as %s", async (layout, kind) => {
      const { inspectManagedGatewayServiceBeforeUpdate } =
        await import("../cli/update-cli/update-command-service-plan.js");
      const { summarizeGatewayServiceLayout } = await import("../daemon/service-layout.js");
      const { stateDir, prefix } = await setup();
      await publishFixture(prefix, "2.0.0", "", false);
      await writeGitReleaseLauncher(prefix);
      const other = await setup();
      await publishFixture(other.prefix, "3.0.0", "", false);
      await writeGitReleaseLauncher(other.prefix);
      const checkout = path.join(stateDir, "checkout");
      const linked = layout === "is a linked worktree forwarding to this launcher";
      await fs.mkdir(path.join(checkout, "dist"), { recursive: true });
      if (linked) {
        await fs.writeFile(path.join(checkout, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      } else if (layout !== "is a package, not a checkout") {
        await fs.mkdir(path.join(checkout, ".git"));
      }
      await fs.writeFile(
        path.join(checkout, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      );
      await fs.writeFile(path.join(checkout, "dist", "index.js"), "");
      await fs.writeFile(path.join(checkout, "openclaw.mjs"), "");
      if (layout !== "lacks the forwarder module") {
        await fs.writeFile(path.join(checkout, "release-launcher-forward.mjs"), "");
      }
      if (layout !== "has no forwarding marker") {
        const launcher =
          layout === "forwards to a missing launcher"
            ? path.join(stateDir, "gone", "openclaw-launcher.mjs")
            : path.join(
                layout === "forwards to another state directory's launcher" ? other.prefix : prefix,
                "openclaw-launcher.mjs",
              );
        // `markForwarding` keeps a main checkout's marker in `.git`, and other trees' at the root.
        const marker =
          linked || layout === "is a package, not a checkout"
            ? path.join(checkout, ".openclaw-launcher")
            : path.join(checkout, ".git", "openclaw-launcher");
        await fs.writeFile(marker, `${launcher}\n`);
      }
      const entry = path.join(
        checkout,
        layout === "forwards openclaw.mjs to this launcher" ? "openclaw.mjs" : "dist/index.js",
      );
      const command = { programArguments: [process.execPath, entry, "gateway", "--port", "1"] };
      const verdict = await inspectManagedGatewayServiceBeforeUpdate({
        // Doctor's root: the package root of the release the CLI was forwarded to.
        root: await fs.realpath(gitReleaseSlot(prefix)),
        state: {
          installed: true,
          loadState: { status: "loaded" },
          running: true,
          env: {},
          command,
          runtime: { status: "running", systemd: { managerUid: 1001 } },
        },
      });

      expect(verdict).toEqual(
        kind === "owned"
          ? expect.objectContaining({ kind, refreshDefinition: false })
          : { kind: "foreign" },
      );
      // `gateway status` compares this version with the CLI's to report drift.
      expect((await summarizeGatewayServiceLayout(command))?.packageVersion).toBe(
        kind === "owned" ? "2.0.0" : layout.includes("another state") ? "3.0.0" : "1.0.0",
      );
    });

    it("runs a Windows checkout from releases behind an absolute junction link", async () => {
      const { stateDir, prefix } = await setup();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      try {
        await withMockedWindowsPlatform(async () => {
          const good = await release(prefix, "1.0.0", 'console.log("old");\n');
          await publishGitRelease({ prefix, releaseRoot: good, trial: false });
          const bad = await release(prefix, "2.0.0", 'throw new Error("boot");\n');
          await publishGitRelease({ prefix, releaseRoot: bad, trial: true });
          // A junction stores, and readlink reports, the absolute release path.
          expect(readPackageReleaseSlotSync(gitReleaseSlot(prefix))?.target).toBe(bad);
        });
        startGateway(prefix);
        startGateway(prefix);

        expect(startGateway(prefix).stdout).toContain("old");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("finishes a link switch killed after the old link was removed", async () => {
      const { prefix } = await setup();
      await publishGitRelease({
        prefix,
        releaseRoot: await release(prefix, "1.0.0", 'console.log("old");\n'),
        trial: false,
      });
      const next = await release(prefix, "2.0.0", 'console.log("new");\n');
      // The Windows switch removes the old link, then renames the temporary one into place.
      const slot = gitReleaseSlot(prefix);
      await fs.symlink(
        path.relative(prefix, next),
        path.join(prefix, ".openclaw.release-link-1-1"),
      );
      await fs.unlink(slot);

      expect(startGateway(prefix).stdout).toBe("new\n");
      expect(await fs.realpath(slot)).toBe(await fs.realpath(next));
    });

    it("moves something other than a release link aside instead of refusing the update", async () => {
      const { stateDir, prefix } = await setup();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      try {
        expect(prepareGitReleaseLayout()).toBeUndefined();
        await fs.mkdir(gitReleaseSlot(prefix), { recursive: true });
        expect(prepareGitReleaseLayout()).toMatch(/was not a release link; it was moved to /u);
        await expect(fs.lstat(gitReleaseSlot(prefix))).rejects.toThrow();
        // A checkout installed there is a live installation: it stays where it is.
        await fs.mkdir(path.join(gitReleaseSlot(prefix), ".git"), { recursive: true });
        expect(prepareGitReleaseLayout()).toMatch(/is a Git checkout at the release link path/u);
        expect((await fs.lstat(gitReleaseSlot(prefix))).isDirectory()).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  },
);
