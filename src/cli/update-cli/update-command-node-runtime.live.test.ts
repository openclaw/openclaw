import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, expect, it, vi } from "vitest";
import { nodeRuntimeFailure, SQLITE_CAPABILITY_PROBE } from "../../../node-sqlite.mjs";
import { resolveWindowsPowerShellPath } from "../../../scripts/windows-cmd-helpers.mjs";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { withEnvAsync } from "../../test-utils/env.js";

const describeLive = process.env.OPENCLAW_LIVE_TEST === "1" ? describe : describe.skip;
const nodeVersion = "24.19.0";

describeLive("private Node provisioning live", () => {
  it(
    "installs through the admitted owner, releases both leases, and reuses the native runtime",
    async () => {
      // Failed or uncertain child cleanup must retain the private owner and its evidence.
      // Delete this fixture only after the real executor and lease checks have settled.
      const fixture = createFixtureLifetime();
      const base = fs.realpathSync(fixture.createTempDir("private-node-owner-"));
      try {
        await fixture.run(async () => {
          const root = path.join(base, "package-B");
          const serviceRoot = path.join(base, "service-A");
          const control = path.join(base, "control");
          const home = path.join(base, "home");
          const temporary = path.join(base, "tmp");
          const recoveryRoot = path.join(home, ".openclaw");
          for (const directory of [root, serviceRoot, control, home, temporary, recoveryRoot]) {
            fs.mkdirSync(directory, { mode: 0o700 });
          }
          const env: NodeJS.ProcessEnv = {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                /^(PATH|SystemRoot|WINDIR|ComSpec|PATHEXT|PROCESSOR_ARCHITECTURE|PROCESSOR_ARCHITEW6432)$/i.test(
                  key,
                ),
              ),
            ),
            HOME: home,
            USERPROFILE: home,
            TMP: temporary,
            TEMP: temporary,
            TMPDIR: temporary,
            CI: "1",
          };
          await withEnvAsync(
            {
              ...env,
              OPENCLAW_HOME: home,
              OPENCLAW_STATE_DIR: recoveryRoot,
              OPENCLAW_CONFIG_PATH: path.join(recoveryRoot, "openclaw.json"),
              OPENCLAW_PROFILE: undefined,
              HOMEDRIVE: undefined,
              HOMEPATH: undefined,
            },
            async () => {
              const [
                tempRoot,
                { resolveUpdatedNodeRuntime },
                { createManagedHandoffLeaseStore },
                { runUtf8CommandWithTimeout },
                { releaseUpdateCommandPreflightForHandoff, withUpdateCommandExecutor },
                { createPackageRuntimeRecovery },
              ] = await Promise.all([
                import("../../infra/tmp-openclaw-dir.js"),
                import("../../../node-runtime-update.mjs"),
                import("../../infra/update-managed-service-handoff-lease.js"),
                import("../../process/exec.js"),
                import("./update-command-executor.js"),
                import("./update-command-node-runtime.js"),
              ]);
              const tempOwner = vi
                .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
                .mockReturnValue(control);
              try {
                expect(fs.readdirSync(recoveryRoot)).toEqual([]);
                const runId = randomUUID();
                let installCount = 0;
                const installed = await withUpdateCommandExecutor(runId, async (executor) => {
                  const fence = await executor.enter(root, { serviceRoot, preflight: true });
                  const recovery = createPackageRuntimeRecovery({
                    root,
                    opts: { run: { runId, env, executorFence: fence }, runtimeRecoveryEnv: env },
                    timeoutMs: DEFAULT_UPDATE_STEP_TIMEOUT_MS,
                  });
                  const installCommand = recovery.installCommand;
                  assert(installCommand);
                  const node = await resolveUpdatedNodeRuntime(recoveryRoot, {
                    nodeVersion,
                    acceptVersion: (version) => version === nodeVersion,
                    env,
                    installCommand: async (command, args, installerEnv) => {
                      installCount += 1;
                      const windows = process.platform === "win32";
                      expect(command).toBe(
                        windows
                          ? resolveWindowsPowerShellPath(env)
                          : process.platform === "darwin"
                            ? "/bin/bash"
                            : "bash",
                      );
                      expect(args).toContain(
                        fileURLToPath(
                          new URL(
                            windows
                              ? "../../../scripts/install.ps1"
                              : "../../../scripts/install-cli.sh",
                            import.meta.url,
                          ),
                        ),
                      );
                      expect(args).toContain(windows ? "-NodeOnly" : "--node-only");
                      expect(args.slice(-2)).toEqual([
                        windows ? "-NodeVersion" : "--node-version",
                        nodeVersion,
                      ]);
                      return installCommand(command, args, installerEnv);
                    },
                  });
                  assert(node);
                  const realNode = fs.realpathSync(node);
                  const relative = path.relative(recoveryRoot, realNode);
                  expect(path.isAbsolute(relative)).toBe(false);
                  expect(relative).not.toMatch(/^\.\.(?:[/\\]|$)/);
                  expect(realNode).not.toBe(fs.realpathSync(process.execPath));
                  const probe = await runUtf8CommandWithTimeout(
                    [
                      node,
                      "-e",
                      `process.stdout.write(JSON.stringify({ version: process.versions.node, probe: ${SQLITE_CAPABILITY_PROBE} }));`,
                    ],
                    {
                      baseEnv: {},
                      env,
                      timeoutMs: 10_000,
                      killProcessTree: true,
                      requireProcessTreeExtinction: true,
                    },
                  );
                  expect(probe).toMatchObject({
                    code: 0,
                    termination: "exit",
                    signal: null,
                    killed: false,
                  });
                  expect(["normal", "cooperative"]).toContain(probe.cleanup);
                  const native = JSON.parse(probe.stdout);
                  expect(native.version).toBe(nodeVersion);
                  expect(nodeRuntimeFailure(native.version, native.probe)).toBeNull();
                  releaseUpdateCommandPreflightForHandoff(fence);
                  expect(() => fence.assertCurrent()).toThrow();
                  return realNode;
                });
                expect(installCount).toBe(1);
                const store = createManagedHandoffLeaseStore();
                for (const key of [root, serviceRoot]) {
                  expect(store.read(key)).toEqual({ kind: "absent" });
                  const contender = store.acquire(key, randomUUID(), { kind: "update" });
                  assert(contender.kind === "acquired");
                  expect(store.release(contender.lease)).toBe(true);
                  expect(store.read(key)).toEqual({ kind: "absent" });
                }
                const unexpectedInstall = vi.fn(() => {
                  throw new Error("Cached runtime unexpectedly requested installation.");
                });
                const cached = await resolveUpdatedNodeRuntime(recoveryRoot, {
                  allowInstall: false,
                  nodeVersion,
                  acceptVersion: (version) => version === nodeVersion,
                  env,
                  installCommand: unexpectedInstall,
                });
                assert(cached);
                expect(fs.realpathSync(cached)).toBe(installed);
                expect(unexpectedInstall).not.toHaveBeenCalled();
              } finally {
                tempOwner.mockRestore();
              }
            },
          );
        });
        // Cleanup joins fixture.run, so call it only after that complete body returns.
        // Windows proves this invocation's join, not custody of escaped dead-root descendants.
        await fixture.cleanup();
        expect(fs.existsSync(base)).toBe(false);
      } catch (cause) {
        throw new Error(`Private Node provisioning fixture retained at ${base}`, { cause });
      }
    },
    DEFAULT_UPDATE_STEP_TIMEOUT_MS + 120_000,
  );
});
