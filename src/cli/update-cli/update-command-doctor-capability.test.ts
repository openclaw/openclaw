import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as commandExec from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import * as postCore from "./update-command-post-core.js";

afterEach(() => vi.restoreAllMocks());

const pluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

it.each([
  { target: "legacy", coreAlreadyCurrent: false },
  { target: "legacy", coreAlreadyCurrent: true },
  { target: "pre-worker", coreAlreadyCurrent: false },
  { target: "modern", coreAlreadyCurrent: false },
  { target: "malformed", coreAlreadyCurrent: false },
  { target: "unknown-protocol", coreAlreadyCurrent: false },
  { target: "probe-failed", coreAlreadyCurrent: false },
  { target: "missing-runner", coreAlreadyCurrent: false },
  { target: "revoked", coreAlreadyCurrent: false },
  { target: "revoked-before-probe", coreAlreadyCurrent: false },
] as const)(
  "converges changed plugins using the $target target Doctor contract (current=$coreAlreadyCurrent)",
  async ({ target, coreAlreadyCurrent }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const root = state.path("target");
      const control = state.path("control");
      const marker = state.path("doctor-calls");
      const targetVersion = target === "pre-worker" ? "2026.7.1" : "2026.9.3";
      await fs.mkdir(control);
      await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
      await state.writeConfig({ plugins: { enabled: false } });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "openclaw",
          type: "module",
          version: targetVersion,
        }),
      );
      await fs.writeFile(
        path.join(root, "dist", "index.js"),
        `import fs from "node:fs";
        if (process.argv.includes("--repair")) fs.appendFileSync(${JSON.stringify(marker)}, "legacy-doctor\\n");
        else if (process.argv.includes("--lint")) process.stdout.write(JSON.stringify({ok:true,checksRun:1,checksSkipped:0,findings:[]}));
        else if (process.argv.includes("validate")) process.stdout.write(JSON.stringify({ok:true}));
        else throw new Error("Unexpected target CLI call");`,
      );
      const owner = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
      const contract =
        target === "malformed"
          ? { state: "invalid", agent: 1 }
          : {
              state: 16,
              agent: 1,
              ...(target === "modern" ? { doctorConfigWrites: "pid-start-v1" } : {}),
              ...(target === "unknown-protocol" ? { doctorConfigWrites: "unknown-v2" } : {}),
            };
      if (target !== "pre-worker") {
        await fs.writeFile(
          path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
          `import fs from "node:fs";
        if (process.argv[2] === "--check") {
          fs.appendFileSync(${JSON.stringify(marker)}, "check\\n");
          process.stdout.write(${JSON.stringify(JSON.stringify(contract))});
          process.exitCode = ${target === "probe-failed" ? 1 : 0};
        } else {
          const input=JSON.parse(fs.readFileSync(0,"utf8"));
          ${
            target === "modern"
              ? `
              ${owner.pathname.endsWith(".ts") ? `await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/tsx.mjs")).href)});` : ""}
              const {withDelegatedUpdateCommandExecutor}=await import(${JSON.stringify(owner.href)});
              await withDelegatedUpdateCommandExecutor(input.executor,input.runId,input.root,async fence=>{
                fence.assertCurrent();
                fs.appendFileSync(${JSON.stringify(marker)},"native-doctor\\n");
              });`
              : `// v2026.9.3 has --check but treats every other invocation as finalization.
              const transferredRun = input.params.opts.run;
              if (!transferredRun) throw new Error("Candidate finalization requires its migrated update run.");`
          }
        }`,
        );
      }
      // Target plugin work is already complete. Parent convergence, capability
      // inspection, both Doctor transports and native executor ownership are real.
      vi.spyOn(postCore, "continuePostCoreUpdateInFreshProcess").mockResolvedValue({
        resumed: true,
        pluginUpdate,
      });
      let current = true;
      if (target === "revoked-before-probe") {
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(async (pathname) => {
          const result = await lstat(pathname);
          if (
            pathname ===
            path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath)
          ) {
            current = false;
          }
          return result;
        });
      }
      const runCommand = commandExec.runUtf8CommandWithTimeout;
      vi.spyOn(commandExec, "runUtf8CommandWithTimeout").mockImplementation(
        async (argv, options) => {
          const result = await runCommand(argv, options);
          if (target === "revoked" && argv.includes("--check")) {
            current = false;
          }
          return result;
        },
      );
      const record = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const opts: UpdateCommandOptions = {
        yes: true,
        json: true,
        run: {
          runId: record.runId,
          env: state.env,
          requesterAuthority: { requester: {}, isCurrent: () => current },
        },
      };
      const configSnapshot = await readConfigFileSnapshot({ observe: false });
      const pending = withUpdateCommandExecutor(record.runId, async (executor) => {
        opts.run!.executorFence = await executor.enter(root);
        return await convergeUpdatePlugins({
          root,
          coreAlreadyCurrent,
          result: {
            status: coreAlreadyCurrent ? "skipped" : "ok",
            mode: "npm",
            root,
            before: { version: "2026.9.6" },
            after: { version: targetVersion },
            steps: [],
            durationMs: 1,
          },
          installKindChanged: false,
          configSnapshot,
          requestedChannel: null,
          storedChannel: null,
          channel: "stable",
          downgradeRisk: true,
          opts,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          updateStepTimeoutMs: 20_000,
          packageUpdateNodeRunner:
            target === "missing-runner" ? state.path("missing-node") : process.execPath,
          assertCurrent: opts.run!.executorFence.assertCurrent,
        });
      });
      if (
        target === "malformed" ||
        target === "unknown-protocol" ||
        target === "probe-failed" ||
        target === "missing-runner" ||
        target === "revoked" ||
        target === "revoked-before-probe"
      ) {
        await expect(pending).rejects.toThrow();
        if (target === "missing-runner" || target === "revoked-before-probe") {
          await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(marker, "utf8")).toBe("check\n");
        }
      } else {
        expect((await pending).resultWithPostUpdate.status).toBe("ok");
        expect(await fs.readFile(marker, "utf8")).toBe(
          `${target === "pre-worker" ? "" : "check\n"}${target === "modern" ? "native" : "legacy"}-doctor\n`,
        );
      }
    });
  },
  45_000,
);
