import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { packControlUiLocaleArtifact } from "../../scripts/control-ui-locale-artifacts.ts";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowExpression,
  readWorkflow,
  readWorkflowOutputs,
  runGit,
  runWorkflowShellScript,
  testNodeExecPath,
  writeExecutable,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";
import { prepareGeneratedPublisherFixture } from "./generated-publisher.test-support.js";

const workflow = readWorkflow(".github/workflows/control-ui-locale-refresh.yml");
const sourceFile = "ui/src/i18n/locales/en.ts";
const assets = "ui/src/i18n/.i18n";
const before =
  '\nObject.assign(en, { localeWorkflowProof: { keep: "Keep locale proof", edit: "Old locale proof {count}", remove: "Remove locale proof" } });\n';
const after =
  '\nObject.assign(en, { localeWorkflowProof: { keep: "Keep locale proof", edit: "New locale proof {name}", add: "Added locale proof" } });\n';
const provider = path.resolve("test/scripts/control-ui-locale-provider.fixture.mjs");
type Context = Parameters<typeof evaluateWorkflowExpression>[1];
type JobResult = { result: "success" | "failure" | "skipped"; outputs: Record<string, string> };
export type ProviderRequest = { ids: string[]; proof: Record<string, string> };
export type FinalizerScenario = {
  repository?: string;
  ref?: string;
  fullRefresh?: boolean;
  preflightAllowed?: boolean;
  change?: "glossary" | "canonical";
  artifactFault?: "foreign-run" | "path" | "fallback";
  publish?: boolean;
  advanceDuringCheckout?: boolean;
  advanceAfterCatchup?: boolean;
};

function put(root: string, file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function providerEnv(root: string, log: string, phase: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_OPTIONS: "--import=" + pathToFileURL(provider).href,
    TSX_DISABLE_CACHE: "1",
    OPENCLAW_STATE_DIR: path.join(root, ".isolated-state"),
    OPENAI_API_KEY: "fixture-key",
    ANTHROPIC_API_KEY: "",
    OPENCLAW_CONTROL_UI_I18N_PROVIDER: "openai",
    OPENCLAW_CONTROL_UI_I18N_MODEL: "fixture-primary",
    OPENCLAW_I18N_FALLBACK_MODEL: "fixture-fallback",
    LOCALE_PROOF_REQUESTS: log,
    LOCALE_PROOF_PHASE: phase,
  };
}
function requests(file: string): ProviderRequest[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ProviderRequest)
    : [];
}
function commit(root: string, message: string) {
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

/** Real scripts and catalogs in a disposable source checkout; only services are fixtures. */
export function createLocaleFinalizerHarness() {
  const temporary = createTempDirTracker();
  let template: string;
  return {
    cleanup: temporary.cleanup,
    async prepare() {
      template = temporary.make("locale-finalizer-source-");
      const repo = process.cwd();
      const files = new Set([
        ...collectRuntimeImportClosure(
          repo,
          [
            "scripts/control-ui-i18n.ts",
            "scripts/control-ui-locale-artifacts.ts",
            "scripts/tsx.mjs",
            "ui/src/i18n/lib/registry.ts",
          ],
          { includeDynamicImports: true },
        ),
        "package.json",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "extensions/active-memory/control-ui.presentation.json",
        "extensions/memory-wiki/control-ui.presentation.json",
        ".github/workflows/control-ui-locale-refresh.yml",
        ".github/actions/publish-generated-pr/action.yml",
        ".github/actions/publish-generated-pr/policy.py",
        ".github/actions/git-owner/owner.py",
      ]);
      for (const file of files) {
        if (file.startsWith("../") || path.isAbsolute(file)) {
          throw new Error("Source capsule escaped repository");
        }
        fs.mkdirSync(path.dirname(path.join(template, file)), { recursive: true });
        fs.copyFileSync(path.join(repo, file), path.join(template, file));
      }
      for (const directory of [
        assets,
        "ui/src/app",
        "ui/src/components",
        "ui/src/lib",
        "ui/src/pages",
      ]) {
        fs.mkdirSync(path.join(template, directory), { recursive: true });
      }
      for (const file of fs.readdirSync(assets)) {
        if (
          file.endsWith(".tm.jsonl") ||
          file.endsWith(".meta.json") ||
          file.startsWith("glossary.")
        ) {
          fs.copyFileSync(path.join(assets, file), path.join(template, assets, file));
        }
      }
      fs.symlinkSync(
        path.join(repo, "node_modules"),
        path.join(template, "node_modules"),
        "junction",
      );
      // Keep each publisher pathspec populated in this sparse checkout. This
      // non-UI plugin is not a generation input; plugin generation has its own proof.
      put(template, "extensions/fixture/openclaw.plugin.json", '{"id":"fixture"}\n');
      put(template, "extensions/fixture/i18n/.i18n/fixture.json", "{}\n");
      put(template, "extensions/fixture/i18n/locales/translated.json", "{}\n");
      fs.appendFileSync(path.join(template, sourceFile), before);
      put(template, ".gitignore", "node_modules/\n.artifacts/\n.isolated-state/\n");
      const seed = spawnSync(
        testNodeExecPath,
        ["--import", "./scripts/tsx.mjs", "scripts/control-ui-i18n.ts", "sync", "--write"],
        {
          cwd: template,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          env: providerEnv(
            template,
            path.join(temporary.make("locale-seed-io-"), "requests"),
            "canonical",
          ),
        },
      );
      expect(seed.status, seed.stdout + seed.stderr).toBe(0);
    },
    async run(scenario: FinalizerScenario = {}) {
      const directory = temporary.make("locale-finalizer-flow-");
      const publisherStep: WorkflowStep = workflow.jobs.finalize.steps.at(-1);
      const fixture = prepareGeneratedPublisherFixture(directory, null, {
        noGeneratedChange: true,
        autoMerge: true,
        headBranch: String(publisherStep.with?.["head-branch"]),
      });
      const root = fixture.worktree;
      // actions/checkout disables GC; detached maintenance would race the Git owner's lock scan.
      runGit(root, ["config", "gc.auto", "0"]);
      runGit(root, ["config", "maintenance.auto", "false"]);
      // Synthetic local transport does not need compression of the large warm TM.
      runGit(root, ["config", "core.compression", "0"]);
      const providerLog = path.join(directory, "finalizer-provider-requests");
      const workerLog = path.join(directory, "worker-provider-requests");
      const states: Record<string, JobResult> = {};
      const trace: Array<{ step: string; status: number | "skipped" }> = [];
      let failure = "";
      let fresh = "";
      let later = "";
      let sourceAtSetup = "";
      let checkouts = 0;
      let updater: string | undefined;
      const advanceMain = (previous: string, next: string) => {
        if (!updater) {
          updater = path.join(directory, "main-updater");
          runGit(directory, ["clone", "--quiet", fixture.env.FAKE_ORIGIN, updater]);
          runGit(updater, ["config", "user.name", "Canonical Main Fixture"]);
          runGit(updater, ["config", "user.email", "main@example.invalid"]);
        }
        const file = path.join(updater, sourceFile);
        const source = fs.readFileSync(file, "utf8");
        expect(source).toContain(previous);
        fs.writeFileSync(file, source.replace(previous, next));
        const revision = commit(updater, "canonical source advances");
        runGit(updater, ["push", "--quiet", "origin", "main"]);
        return revision;
      };
      const context: Context = {
        eventName: "workflow_dispatch",
        repository: scenario.repository ?? "openclaw/openclaw",
        ref: scenario.ref ?? "refs/heads/main",
        runAttempt: 1,
        runId: 123,
        runnerTemp: fixture.env.RUNNER_TEMP,
        workflowToken: "fixture-runtime-token",
        githubEvent: { repository: { default_branch: "main", name: "openclaw" } },
        inputs: { full_refresh: scenario.fullRefresh ?? false, token_preflight_only: false },
        additionalNeeds: states,
        steps: {},
        secrets: {
          OPENCLAW_DOCS_I18N_OPENAI_API_KEY: "fixture-key",
          OPENCLAW_I18N_MODEL: "fixture-primary",
          OPENCLAW_I18N_FALLBACK_MODEL: "fixture-fallback",
        },
      };
      const expression = (source: string) =>
        evaluateWorkflowExpression("${{ " + source + " }}", context);
      const interpolate = (value: unknown) =>
        String(value).replace(/\$\{\{([\s\S]*?)\}\}/gu, (_match, source: string) =>
          String(expression(source)),
        );
      const baseEnv: NodeJS.ProcessEnv = {
        ...providerEnv(root, providerLog, "finalizer"),
        ...fixture.env,
      };
      // Credentials are projected only by the workflow step that declares them.
      delete baseEnv.OPENAI_API_KEY;
      delete baseEnv.ANTHROPIC_API_KEY;
      delete baseEnv.OPENCLAW_CONTROL_UI_I18N_MODEL;
      delete baseEnv.OPENCLAW_I18N_FALLBACK_MODEL;
      Object.assign(baseEnv, {
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        PROOF_AUTOMERGE_ALLOWED: String(scenario.preflightAllowed ?? true),
      });
      fs.symlinkSync(testNodeExecPath, path.join(fixture.fakeBin, "node"));
      fs.renameSync(path.join(fixture.fakeBin, "gh"), path.join(fixture.fakeBin, "publisher-gh"));
      baseEnv.PROOF_PUBLISHER_GH = path.join(fixture.fakeBin, "publisher-gh");
      writeExecutable(path.join(fixture.fakeBin, "gh"), [
        "#!/bin/bash",
        "set -euo pipefail",
        'if [[ "$1:$2" == "api:graphql" ]]; then',
        '  if [[ "$*" == *autoMergeAllowed* ]]; then printf "%s\\n" "$PROOF_AUTOMERGE_ALLOWED"; exit 0; fi',
        '  sha="$(git rev-parse HEAD)"',
        '  config="$(git show HEAD:scripts/lib/control-ui-i18n-config.json)"',
        '  jq -n --arg sha "$sha" --arg config "$config" \'{data:{repository:{revision:{oid:$sha},config:{text:$config}}}}\'',
        "  exit 0",
        "fi",
        'exec "$PROOF_PUBLISHER_GH" "$@"',
      ]);
      writeExecutable(path.join(fixture.fakeBin, "timeout"), [
        "#!/bin/bash",
        'while [[ "$#" -gt 0 ]]; do case "$1" in --signal=*|--kill-after=*) shift ;; [0-9]*s) shift; break ;; *) break ;; esac; done',
        'exec "$@"',
      ]);
      const gate = (job: string) => {
        context.failed = false;
        const allowed = Boolean(expression(workflow.jobs[job].if));
        if (!allowed) {
          states[job] = { result: "skipped", outputs: {} };
        }
        return allowed;
      };
      const execute = (step: WorkflowStep, extra: NodeJS.ProcessEnv = {}) => {
        if (!expression(step.if ?? "success()")) {
          trace.push({ step: step.name ?? "unnamed", status: "skipped" });
          return false;
        }
        if (!step.run) {
          throw new Error("Expected executable workflow step: " + step.name);
        }
        const output = path.join(directory, "output-" + trace.length);
        const env = {
          ...baseEnv,
          ...extra,
          ...Object.fromEntries(
            Object.entries(step.env ?? {}).map(([key, value]) => [key, interpolate(value)]),
          ),
          GITHUB_OUTPUT: output,
        };
        const result = runWorkflowShellScript(step.run, { cwd: root, env, linuxWorkflow: true });
        trace.push({ step: step.name ?? "unnamed", status: result.status ?? 1 });
        if (result.status !== 0) {
          context.failed = true;
          failure = result.stdout + result.stderr;
          return false;
        }
        if (step.id) {
          context.steps![step.id] = { outputs: readWorkflowOutputs(output), outcome: "success" };
        }
        return true;
      };
      const result = () => ({
        root,
        fresh,
        later,
        sourceAtSetup,
        admittedSource: context.steps?.locale_memory?.outputs.sha,
        states,
        trace,
        failure,
        providerRequests: requests(providerLog),
        workerRequests: requests(workerLog),
        publicationCalls: fs.existsSync(fixture.env.FAKE_GH_CALLS)
          ? fs.readFileSync(fixture.env.FAKE_GH_CALLS, "utf8").trim().split("\n")
          : [],
        publication: fixture.inspect(""),
        publishedMemory(locale: string) {
          const readback = spawnSync(
            "git",
            [
              "--git-dir",
              fixture.env.FAKE_ORIGIN,
              "show",
              "refs/heads/" + fixture.env.HEAD_BRANCH + ":" + assets + "/" + locale + ".tm.jsonl",
            ],
            { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
          );
          expect(readback.status, readback.stderr).toBe(0);
          return readback.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { segment_id: string; translated: string });
        },
        memory(locale: string) {
          return fs
            .readFileSync(path.join(root, assets, locale + ".tm.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as { segment_id: string; translated: string; text: string },
            );
        },
      });
      if (!gate("resolve-base")) {
        return result();
      }
      fs.cpSync(template, root, {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
        verbatimSymlinks: true,
      });
      const svFile = path.join(root, assets, "sv.tm.jsonl");
      const canonicalSv = fs
        .readFileSync(svFile, "utf8")
        .trim()
        .split("\n")
        .filter(
          (line) =>
            scenario.fullRefresh || !JSON.parse(line).segment_id.startsWith("localeWorkflowProof."),
        );
      fs.writeFileSync(svFile, canonicalSv.join("\n") + "\n");
      commit(root, "canonical source before workers");
      runGit(root, ["push", "--quiet", "origin", "main"]);
      const resolveStep: WorkflowStep = workflow.jobs["resolve-base"].steps[0];
      const resolved = execute(resolveStep);
      states["resolve-base"] = {
        result: resolved ? "success" : "failure",
        outputs: context.steps!.base?.outputs ?? {},
      };
      if (!resolved || !gate("publisher-preflight")) {
        return result();
      }
      // App-token issuance and GitHub repository settings are external services.
      context.steps = { tokens: { outputs: { "pull-request-token": "test-token" } } };
      const preflight: WorkflowStep = workflow.jobs["publisher-preflight"].steps.find(
        (step: WorkflowStep) => step.run,
      );
      const ready = execute(preflight);
      states["publisher-preflight"] = { result: ready ? "success" : "failure", outputs: {} };
      if (!gate("refresh")) {
        gate("finalize");
        return result();
      }
      const sourceCommit = states["resolve-base"].outputs.sha!;
      const locales: string[] = JSON.parse(states["resolve-base"].outputs.locales!);
      context.matrix = { locale: "sv" };
      const worker: WorkflowStep = workflow.jobs.refresh.steps.find(
        (step: WorkflowStep) => step.name === "Refresh locale translations",
      );
      expect(
        execute(worker, { LOCALE_PROOF_REQUESTS: workerLog, LOCALE_PROOF_PHASE: "worker" }),
        failure,
      ).toBe(true);
      const artifacts = path.join(directory, "worker-artifacts");
      // Warm siblings were generated by the real aggregate CLI in prepare().
      // Pack every locale through the maintained producer, not fabricated JSON.
      for (const locale of locales) {
        await packControlUiLocaleArtifact({
          root,
          directory: artifacts,
          locale,
          identity: { sourceCommit, runId: "123", runAttempt: "1" },
        });
      }
      states.refresh = { result: "success", outputs: {} };
      runGit(root, ["restore", "--worktree", "--", assets]);
      const english = fs.readFileSync(path.join(root, sourceFile), "utf8");
      expect(english).toContain(before);
      fs.writeFileSync(path.join(root, sourceFile), english.replace(before, after));
      if (scenario.change === "glossary") {
        put(root, assets + "/glossary.sv.json", '[{"source":"locale","target":"språk"}]\n');
      }
      if (scenario.change === "canonical") {
        const packed = JSON.parse(fs.readFileSync(path.join(artifacts, "sv.json"), "utf8"));
        const kept = packed.memories[0].content
          .trim()
          .split("\n")
          .map((line: string) => JSON.parse(line))
          .find((entry: { segment_id: string }) => entry.segment_id === "localeWorkflowProof.keep");
        fs.appendFileSync(
          svFile,
          JSON.stringify({ ...kept, translated: "Canonical correction" }) + "\n",
        );
      }
      fresh = commit(root, "main advances while workers finish");
      runGit(root, ["push", "--quiet", "origin", "main"]);
      runGit(root, ["checkout", "--quiet", "--detach", sourceCommit]);
      if (scenario.artifactFault) {
        const file = path.join(artifacts, "sv.json");
        const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
        if (scenario.artifactFault === "foreign-run") {
          artifact.runId = "999";
        }
        if (scenario.artifactFault === "path") {
          artifact.memories[0].path = "../../outside.ts";
        }
        if (scenario.artifactFault === "fallback") {
          artifact.memories[0].metadata.fallbackKeys = ["missing"];
        }
        fs.writeFileSync(file, JSON.stringify(artifact));
      }
      if (!gate("finalize")) {
        return result();
      }
      context.steps = {};
      for (const step of workflow.jobs.finalize.steps as WorkflowStep[]) {
        if (context.failed) {
          trace.push({ step: step.name ?? "unnamed", status: "skipped" });
          continue;
        }
        if (step.run) {
          execute(step);
        } else if (step.uses?.startsWith("actions/checkout@")) {
          const ref = interpolate(step.with?.ref);
          const depth = Number(step.with?.["fetch-depth"] ?? 1);
          const depthArgs =
            depth > 0
              ? ["--depth", String(depth)]
              : fs.existsSync(path.join(root, ".git", "shallow"))
                ? ["--unshallow"]
                : [];
          runGit(root, ["fetch", "--quiet", ...depthArgs, "origin", ref]);
          if (checkouts++ === 0 && scenario.advanceDuringCheckout) {
            // Git advertises the ref before transferring its pack. Advancing the
            // remote after fetch, before checkout, models that stale-ref window
            // deterministically without delaying the service fixture.
            fresh = advanceMain("Added locale proof", "Latest locale proof");
          }
          runGit(root, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
        } else if (step.uses?.startsWith("actions/download-artifact@")) {
          expect(step.with).not.toHaveProperty("run-id");
          fs.cpSync(artifacts, interpolate(step.with?.path), { recursive: true });
        } else if (step.uses === "./.github/actions/setup-node-env") {
          sourceAtSetup = runGit(root, ["rev-parse", "HEAD"]);
          // The source capsule already binds the installed dependency tree.
          expect(fs.existsSync(path.join(root, "node_modules"))).toBe(true);
        } else if (step.uses === "./.github/actions/publish-generated-pr") {
          if (!scenario.publish) {
            break;
          }
          if (scenario.advanceAfterCatchup) {
            later = advanceMain("Latest locale proof", "Later locale proof");
          }
          const inputs = Object.fromEntries(
            Object.entries(step.with ?? {}).map(([key, value]) => [key, interpolate(value)]),
          );
          const action = readWorkflow(".github/actions/publish-generated-pr/action.yml");
          const publication: WorkflowStep = action.runs.steps.find(
            (candidate: WorkflowStep) => candidate.name === "Publish generated pull request",
          );
          const run = runWorkflowShellScript(publication.run!, {
            cwd: root,
            linuxWorkflow: true,
            env: {
              ...baseEnv,
              ...Object.fromEntries(
                Object.entries(publication.env ?? {})
                  .filter(([key]) => key !== "PUBLISH_ACTION_PATH")
                  .map(([key, value]) => [
                    key,
                    String(
                      evaluateWorkflowExpression(value, {
                        ...context,
                        inputs: {
                          ...Object.fromEntries(
                            Object.entries<{ default?: unknown }>(action.inputs).map(
                              ([name, input]) => [name, input.default],
                            ),
                          ),
                          ...inputs,
                        },
                        steps: {
                          tokens: {
                            outputs: {
                              "contents-token": "contents-token",
                              "pull-request-token": "test-token",
                            },
                          },
                        },
                      }),
                    ),
                  ]),
              ),
              CI_GIT_OWNER: path.join(root, ".github/actions/git-owner/owner.py"),
              PUBLISH_ACTION_PATH: path.join(root, ".github/actions/publish-generated-pr"),
            },
          });
          trace.push({ step: step.name!, status: run.status ?? 1 });
          expect(run.status, run.stdout + run.stderr).toBe(0);
        } else {
          throw new Error("Unhandled finalizer step: " + step.name);
        }
      }
      return result();
    },
  };
}
