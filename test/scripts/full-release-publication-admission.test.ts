import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, describe, expect, vi, type TestContext } from "vitest";
import { parse } from "yaml";
import {
  createPublicationObservations,
  normalizePublicationIntent,
  publicationIntentInputs,
  publicationSourceContract,
  publicationSourceJson,
  publicationSourceRequest,
  createPublicationSourceFact,
  validatePublicationSourceBinding,
  type PublicationSourceFact,
} from "../../scripts/full-release-publication-contract.mjs";
import type { ClawHubPublicationState } from "../../scripts/lib/clawhub-publication-state.mjs";
import { resolveReleaseContextIdentity } from "../../scripts/lib/release-context.mjs";
import { getProcessStartTime, isPidDefinitelyDead } from "../../src/shared/pid-alive.js";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";
import { prepareCopiedSourceModules } from "./copied-source-modules.test-support.js";
import {
  publicationSelectionFixture,
  publicationSourceEnv,
} from "./full-release-validation-state.test-support.js";
import { preparedScriptWrapperPreload } from "./prepared-script-wrapper.test-support.js";
import {
  SOURCE_ADMISSION_PATHS as toolingPaths,
  PUBLICATION_TRANSPORT_PATHS,
} from "./release-inventory-paths.test-support.js";
import { prepareSourceInventoryAdmission } from "./source-inventory-admission.test-support.js";

type PublicationContext = TestContext & { command: CommandFixture };
function withCommand(
  body: (command: CommandFixture, check: TestContext["expect"]) => Promise<void>,
) {
  return ({ command, expect: check }: PublicationContext) =>
    command.lifetime.run(() => body(command, check));
}
function withCase<T>(
  body: (value: T, command: CommandFixture, check: TestContext["expect"]) => Promise<void>,
) {
  return (value: T, { command, expect: check }: PublicationContext) =>
    command.lifetime.run(() => body(value, command, check));
}

const publicationIt = createCommandTest();
beforeAll(() => {
  vi.setConfig({ maxConcurrency: 2 });
  return () => vi.resetConfig();
});
const templateDirs = useAutoCleanupTempDirTracker(afterAll);
let toolingTemplate: { loose: string; packed: string };
const repo = resolve(".");
const nodeExecutable = realpathSync(requireNodeTool("node"));
const workflowBash = process.platform === "darwin" ? resolveWorkflowBash() : "bash";
const workflowPath = ".github/workflows/full-release-validation.yml";
type Step = {
  name: string;
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
};
type Workflow = {
  env: Record<string, string>;
  on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
  jobs: Record<string, { steps: Step[]; if?: string; needs?: string | string[] }>;
};
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = parse(workflowSource) as Workflow;
// Retained pre-admission fixtures are explicit historical workflow sources.
const historicalWorkflow = parse(
  workflowSource.replace(/^ {2}FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT:.*\n/mu, ""),
) as Workflow;

const write = (directory: string, path: string, bytes: string | Buffer) => {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
};
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const readJsonLines = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];
const writeJson = (directory: string, path: string, value: unknown) =>
  write(directory, path, JSON.stringify(value));
const successfulStep = (outputs: Record<string, string>) => ({ outputs, outcome: "success" });
const git = (directory: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "--no-lazy-fetch",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const commit = (directory: string) => {
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "fixture");
  return git(directory, "rev-parse", "HEAD");
};
beforeAll(async () => {
  const prepared = templateDirs.make("frv-publication-tooling-template-");
  git(prepared, "init", "-q", "-b", "main");
  for (const path of [...toolingPaths, "scripts/lib/release-publish-children.sh"]) {
    write(prepared, path, readFileSync(join(repo, path)));
  }
  for (const directory of [".github/workflows", "scripts/e2e/lib/upgrade-survivor/config-recipe"]) {
    cpSync(join(repo, directory), join(prepared, directory), { recursive: true });
  }
  symlinkSync(join(repo, "node_modules"), join(prepared, "node_modules"), "junction");
  await prepareCopiedSourceModules(
    prepared,
    toolingPaths.filter((file) => /\.[cm]?ts$/u.test(file)),
  );
  rmSync(join(prepared, "node_modules"));
  commit(prepared);
  const packed = templateDirs.make("frv-publication-packed-tooling-template-");
  cpSync(prepared, packed, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
  git(packed, "repack", "-ad");
  toolingTemplate = { loose: prepared, packed };
});

const selection = publicationSelectionFixture();
const windowsSelection = {
  ...selection,
  windowsNodeTag: "v0.5.0",
  windowsNodeInstallerDigests: { "installer.exe": `sha256:${"a".repeat(64)}` },
};
const unobservedFailure = { status: 1, observations: undefined, firstHopJobs: [] };
const settledWorker = expect.objectContaining({ kind: "settled", worker: true, active: 0 });
const isolatedWorker = { kind: "runtime", worker: true, inherited: [] };
const platform = (id: string) => expect.objectContaining({ id });

function selectedPlugins(...plugins: string[]) {
  return { ...selection, publishOpenclawNpm: false, pluginPublishScope: "selected", plugins };
}

function bindSource(sourceAdmission: unknown, fields: Record<string, unknown> = {}) {
  return validatePublicationSourceBinding({
    sourceAdmissionContract: "1",
    sourceAdmission,
    ...fields,
  });
}

function refreshDigest(fact: { digest: string }) {
  const { digest: _digest, ...content } = fact;
  fact.digest = createHash("sha256").update(publicationSourceJson(content)).digest("hex");
}

describe("publication dispatch transport", () => {
  const identity = { ref: "main", fullRef: "refs/heads/main", sha: "a".repeat(40) };
  const envelope = {
    trustedWorkflow: identity,
    validationPurpose: "publish",
    publicationSelection: selection,
  };
  publicationIt.concurrent.for<{
    name: string;
    value: unknown;
    pass?: boolean;
    identityFailure?: boolean;
    currentWorkflow?: boolean;
    error?: string;
    extra?: Record<string, string>;
  }>([
    { name: "explicit identity", value: envelope, pass: true },
    {
      name: "current publish missing admission",
      value: envelope,
      currentWorkflow: true,
      error:
        "Fresh publication qualification requires an independently admitted candidate-owned request",
    },
    {
      name: "direct identity inference",
      value: { ...envelope, trustedWorkflow: null },
      pass: true,
    },
    {
      name: "missing purpose",
      value: { trustedWorkflow: identity, publicationSelection: selection },
      error: "source-admission envelope requires identity, purpose and selection",
    },
    { name: "old flat identity", value: identity, error: "invalid source-admission envelope" },
    {
      name: "extra identity field",
      value: { ...envelope, trustedWorkflow: { ...identity, extra: true } },
      error: "invalid source-admission tooling identity",
    },
    {
      name: "invalid intent",
      value: { ...envelope, validationPurpose: "diagnostic" },
      error: "nonpublish purpose must omit publication selection",
    },
    {
      name: "wrong identity SHA",
      value: { ...envelope, trustedWorkflow: { ...identity, sha: "b".repeat(40) } },
      identityFailure: true,
      error: "direct workflow identity must match the executing workflow ref and SHA",
    },
    {
      name: "conflicting representation",
      value: envelope,
      extra: { validation_purpose: "diagnostic" },
      error: "source intent must use only the trusted_workflow_json envelope",
    },
    { name: "malformed JSON", value: "{", error: "JSON at position 1" },
  ])(
    "decodes $name before identity effects in the real workflow bodies",
    withCase(
      async (
        { name, value, pass, identityFailure, currentWorkflow, error, extra },
        processFixture,
        check,
      ) => {
        const root = processFixture.createTempDir("openclaw-publication-transport-");
        for (const file of PUBLICATION_TRANSPORT_PATHS) {
          const destination = join(root, "workflow", file);
          mkdirSync(dirname(destination), { recursive: true });
          cpSync(join(repo, file), destination);
        }
        const bin = join(root, "bin");
        mkdirSync(bin);
        const calls = join(root, "calls.jsonl");
        writeFileSync(
          join(bin, "gh"),
          `#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) !== ${JSON.stringify(
            JSON.stringify([
              "api",
              `repos/openclaw/openclaw/compare/${identity.sha}...main`,
              "--method",
              "GET",
              "--jq",
              "{status}",
            ]),
          )}) process.exit(91);
console.log('{"status":"identical"}');
`,
          { mode: 0o755 },
        );
        const steps: Record<string, { outputs: Record<string, string> }> = {};
        const inputs = {
          trusted_workflow_json: typeof value === "string" ? value : JSON.stringify(value),
          ...extra,
        };
        const selectedWorkflow = currentWorkflow ? workflow : historicalWorkflow;
        const resolveTarget = expectDefined(
          selectedWorkflow.jobs.resolve_target,
          "resolve_target job",
        );
        const decoderIndex = resolveTarget.steps.findIndex(
          (step) => step.id === "publication_dispatch",
        );
        const identityIndex = resolveTarget.steps.findIndex(
          (step) => step.id === "tooling_identity",
        );
        check(decoderIndex).toBeGreaterThan(0);
        check(identityIndex).toBeGreaterThan(decoderIndex);
        check(identityIndex).toBeLessThan(
          resolveTarget.steps.findIndex((step) => step.id === "resolve"),
        );
        let status = 0;
        let stderr = "";
        const completed: string[] = [];
        for (const step of [
          expectDefined(resolveTarget.steps[decoderIndex], "publication dispatch step"),
          expectDefined(resolveTarget.steps[identityIndex], "tooling identity step"),
        ]) {
          const output = join(root, `${step.id}.out`);
          const env: Record<string, string> = {
            PATH: [bin, dirname(nodeExecutable), process.env.PATH ?? ""].join(delimiter),
            HOME: root,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GITHUB_OUTPUT: output,
          };
          const context = {
            inputs,
            steps,
            toJSON: JSON.stringify,
            github: { token: "", ref: identity.fullRef, ref_name: identity.ref, sha: identity.sha },
            env: selectedWorkflow.env,
          };
          Object.assign(env, workflowEnv(step.env, context));
          const result = await processFixture.run(
            workflowBash,
            ["-c", expectDefined(step.run, "transport command")],
            {
              cwd: root,
              env,
              encoding: "utf8",
              timeout: 10_000,
            },
          );
          if (result.error !== undefined) {
            throw result.error instanceof Error
              ? result.error
              : new Error("Unexpected publication command failure", { cause: result.error });
          }
          status = result.status ?? 1;
          stderr += result.stderr;
          if (status !== 0) {
            break;
          }
          completed.push(step.id!);
          const outputs = workflowOutputs(output, "trimEnd");
          steps[step.id!] = { outputs };
        }
        if (pass) {
          check(status, stderr).toBe(0);
          check(
            JSON.parse(expectDefined(steps.tooling_identity?.outputs.json, "resolved identity")),
          ).toEqual(identity);
          check(completed).toEqual(["publication_dispatch", "tooling_identity"]);
          const forwarded = expectDefined(
            steps.publication_dispatch?.outputs.trusted_workflow_json,
            "identity transport",
          );
          check(forwarded ? JSON.parse(forwarded) : null).toEqual(
            name === "direct identity inference" ? null : identity,
          );
          check(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
        } else {
          check(status, stderr).toBe(1);
          check(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
          check(stderr).toContain(expectDefined(error, "expected rejection reason"));
          check(completed).toEqual(identityFailure ? ["publication_dispatch"] : []);
          check(existsSync(calls)).toBe(false);
          check(steps.tooling_identity).toBeUndefined();
        }
      },
    ),
  );
});

function evaluate(expression: string, context: Record<string, unknown>) {
  const source = expression.replace(/^\s*\$\{\{|\}\}\s*$/gu, "").trim();
  return runInNewContext(source, {
    ...context,
    always: () => true,
    success: () => true,
    cancelled: () => false,
    fromJSON: JSON.parse,
    contains: (value: string | unknown[], member: string) => value.includes(member),
  }) as unknown;
}

function workflowEnv(variables: Step["env"], context: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(variables ?? {}).map(([key, raw]) => [
      key,
      raw.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match, expression: string) => {
        const value = evaluate(expression, { ...context, toJSON: JSON.stringify });
        if (value === null || value === undefined) {
          return "";
        }
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        throw new Error("Workflow environment interpolation must be scalar");
      }),
    ]),
  );
}

function workflowOutputs(path: string, trim: "trim" | "trimEnd" = "trim") {
  if (trim === "trim" && !existsSync(path)) {
    return {};
  }
  const lines = readFileSync(path, "utf8")[trim]().split("\n");
  return Object.fromEntries(
    (trim === "trim" ? lines.filter(Boolean) : lines).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

async function fixture(
  processFixture: CommandFixture,
  check: TestContext["expect"],
  requestedOptions: {
    nearLimitPack?: boolean;
    version?: string;
    targetContextRef?: string;
    purpose?: string;
    selection?: Record<string, unknown> | null;
    sameSha?: boolean;
    qualification?: "valid" | "wrong-input" | "wrong-archive" | "expired";
    legacyGhArchive?: boolean;
    toolingFullRef?: string;
    androidPin?: string;
    legacyPlatforms?: "absent-helper" | "dormant-helper";
    registry?:
      | "healthy"
      | "npm-empty-history"
      | "npm-error"
      | "clawhub-error"
      | "prepared-trust"
      | "npm-absent"
      | "clawhub-absent"
      | "missing-trust"
      | "advisory-error"
      | "advisory-budget"
      | "required-budget"
      | "advisory-deadline"
      | "parent-interrupt"
      | "concurrency"
      | "abort-peer";
    rerunGroup?: string;
    pluginCount?: number;
    clawhubPublication?: Record<string, ClawHubPublicationState>;
    pluginVersion?: string;
    npmOnlyPlugin?: boolean;
    absentNpmPackage?: "openclaw" | "@openclaw/demo-plugin" | "@openclaw/gateway-client";
    includeCorePackage?: boolean;
    latestDependency?: boolean;
    advisoryCount?: number;
    parentSignal?: "SIGINT" | "SIGTERM";
    uploadFault?: "failure" | "wrong-descriptor" | "late-admission";
    fault?:
      | "readme"
      | "size-missing"
      | "size-wrong-oid"
      | "size-unterminated"
      | "size-extra"
      | "size-individual-limit"
      | "size-total-limit"
      | "size-limit-before-truncated"
      | "candidate-object"
      | "tooling-object"
      | "bootstrap"
      | "import"
      | "yaml"
      | "symlink"
      | "non-utf8"
      | "dirty-candidate"
      | "dirty-android-pin"
      | "platform-helper"
      | "platform-helper-object"
      | "worker-import"
      | "worker-object"
      | "unselected";
  } = {},
) {
  const options = requestedOptions.qualification
    ? { ...requestedOptions, sameSha: true, toolingFullRef: "refs/heads/inventory-candidate" }
    : requestedOptions;
  const root = processFixture.createTempDir("frv-publication-admission-");
  const tooling = join(root, "workflow");
  let target = join(root, "target");
  const temporary = join(root, "tmp");
  for (const directory of [target, temporary]) {
    mkdirSync(directory);
  }
  git(target, "init", "-q");
  const version = options.version ?? "2026.9.9";
  writeJson(target, "package.json", { name: "openclaw", version, type: "module" });
  const androidVersion = JSON.stringify({
    version: options.androidPin ?? version.split("-")[0],
  });
  write(target, "apps/android/version.json", androidVersion);
  const writePlugins = (directory: string) => {
    for (let index = 0; index < (options.pluginCount ?? 1); index += 1) {
      const plugin = writePublishablePluginFixture(directory, {
        extensionId: index === 0 ? "demo-plugin" : `demo-${index}`,
        version: options.pluginVersion ?? version,
        publishTo: options.npmOnlyPlugin ? "npm" : "both",
        ...(options.latestDependency
          ? {
              dependency: { packageName: "demo-runtime", version: "1.2.3", requireLatest: true },
            }
          : {}),
      });
      if (options.advisoryCount) {
        const manifestPath = join(plugin.packageDir, "package.json");
        const manifest = readJson(manifestPath);
        const names = Array.from({ length: options.advisoryCount }, (_, n) => `advisory-${n}`);
        manifest.dependencies = Object.fromEntries(names.map((name) => [name, "1.2.3"]));
        manifest.openclaw.release.requireLatestDependencies = names;
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      write(
        directory,
        `extensions/${plugin.extensionId}/index.ts`,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "forbidden"))}, "candidate code executed");\nthrow new Error("candidate code executed");\n`,
      );
    }
    if (options.includeCorePackage) {
      writeJson(directory, "packages/gateway-client/package.json", {
        name: "@openclaw/gateway-client",
        version,
        openclaw: { release: { publishToNpm: true } },
      });
    }
  };
  writePlugins(target);
  if (options.nearLimitPack) {
    // Binary README data stays inert; reserve raw space for trees and other metadata.
    for (let index = 0; index < 4; index += 1) {
      write(
        target,
        `extensions/pack-boundary-${index}/README.md`,
        randomBytes(16 * 1024 * 1024 - (index === 3 ? 8192 : 0)),
      );
    }
  }
  if (options.fault === "unselected") {
    const other = writePublishablePluginFixture(target, {
      extensionId: "other-plugin",
      version,
      publishTo: "both",
    });
    rmSync(join(other.packageDir, "README.md"));
  }
  if (options.fault === "readme" || options.fault === "symlink") {
    rmSync(join(target, "extensions/demo-plugin/README.md"));
  }
  if (options.fault === "symlink") {
    symlinkSync("package.json", join(target, "extensions/demo-plugin/README.md"));
  }
  let targetSha = commit(target);
  if (options.fault === "non-utf8") {
    const blobSha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: target,
      encoding: "utf8",
      input: "{}",
    }).trim();
    execFileSync("git", ["update-index", "--add", "-z", "--index-info"], {
      cwd: target,
      input: Buffer.concat([
        Buffer.from(`100644 ${blobSha}\t`),
        Buffer.from("extensions/"),
        Buffer.from([0xff]),
        Buffer.from("/package.json\0"),
      ]),
    });
    git(target, "commit", "-qm", "non-utf8 fixture");
    targetSha = git(target, "rev-parse", "HEAD");
  }
  // These faults delete individual loose blobs; other cases copy compact packed history.
  const template = ["tooling-object", "platform-helper-object", "worker-object"].includes(
    options.fault ?? "",
  )
    ? toolingTemplate.loose
    : toolingTemplate.packed;
  cpSync(template, tooling, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
  // Retained main/cross-revision cases explicitly model a pre-admission workflow.
  // The candidate case below keeps the current marker and full P proof.
  if (!options.qualification) {
    const path = join(tooling, workflowPath);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        /^ {2}FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT:.*\n/mu,
        "",
      ),
    );
  }
  const registryCalls = join(root, "registry-calls.jsonl");
  await processFixture.lifetime.acquire(async () => ({
    cleanup: async () => {
      for (const entry of readJsonLines<{
        kind?: string;
        pid?: number;
        startTicks?: string | null;
      }>(registryCalls)) {
        if (entry.kind !== "worker-boundary") {
          continue;
        }
        if (typeof entry.pid !== "number" || !Number.isInteger(entry.pid) || entry.pid <= 0) {
          throw new Error("Publication fixture worker identity is unavailable");
        }
        if (isPidDefinitelyDead(entry.pid)) {
          continue;
        }
        const currentStart = getProcessStartTime(entry.pid);
        if (
          entry.startTicks != null &&
          currentStart !== null &&
          String(currentStart) !== entry.startTicks
        ) {
          continue;
        }
        throw new Error("Publication fixture worker closure is unverified");
      }
    },
  }));
  {
    // This is committed trusted fixture code, not a candidate preload or a
    // production injection flag. Every attempted public read stays in memory.
    write(
      tooling,
      "scripts/tsx.mjs",
      readFileSync(join(tooling, "scripts/tsx.mjs"), "utf8") +
        "\n" +
        preparedScriptWrapperPreload(
          toolingPaths
            .filter((source) => /\.[cm]?ts$/u.test(source))
            .map(
              (source) =>
                [
                  pathToFileURL(join(tooling, source)),
                  pathToFileURL(join(tooling, source.replace(/\.[cm]?ts$/u, ".js"))),
                ] as const,
            ),
        ) +
        `
const { appendFileSync } = await import("node:fs");
const { basename } = await import("node:path");
const record = (value) => appendFileSync(${JSON.stringify(registryCalls)}, JSON.stringify(value) + "\\n");
const worker = basename(process.argv[1] ?? "") === "full-release-publication-observations.mts";
const sizeFault = ${JSON.stringify(options.fault)};
if (sizeFault?.startsWith("size-") || ${JSON.stringify(options.nearLimitPack ?? false)}) {
  const childProcess = (await import("node:child_process")).default;
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (file, args, ...rest) => {
    if (file === "git" && args.includes("pack-objects")) record({ kind: "source-pack" });
    const output = original(file, args, ...rest);
    if (${JSON.stringify(options.nearLimitPack ?? false)} && file === "git") {
      if (args.includes("pack-objects")) record({ kind: "packed-source", bytes: output.length });
      if (args.includes("index-pack")) record({ kind: "indexed-source" });
      if (args.includes("--batch-check=%(objectname) %(objectsize)")) {
        record({ kind: "raw-source", bytes: output.toString().trim().split(String.fromCharCode(10)).reduce((total, row) => total + Number(row.split(" ")[1]), 0) });
      }
    }
    if (file !== "git" || !args.includes("--batch-check=%(objectname) %(objectsize)")) return output;
    record({ kind: "object-size-batch" });
    const rows = output.toString().split("\\n");
    const oid = rows[0].split(" ")[0];
    if (sizeFault === "size-missing") rows[0] = oid + " missing";
    if (sizeFault === "size-wrong-oid") rows[0] = (oid[0] === "0" ? "1" : "0") + rows[0].slice(1);
    if (sizeFault === "size-unterminated") rows.pop();
    if (sizeFault === "size-extra") rows.push(rows[0], "");
    if (["size-individual-limit", "size-limit-before-truncated"].includes(sizeFault)) rows[0] = oid + " 16777217";
    if (sizeFault === "size-limit-before-truncated") rows.splice(-2);
    if (sizeFault === "size-total-limit") {
      for (let i = 0; i < rows.length - 1; i++) rows[i] = rows[i].split(" ")[0] + " 16777216";
    }
    return Buffer.from(rows.join("\\n"));
  };
  (await import("node:module")).syncBuiltinESMExports();
}
record({
  kind: "runtime",
  worker,
  inherited: ["GH_TOKEN", "NPM_TOKEN", "NODE_OPTIONS", "NODE_PATH", "HTTPS_PROXY", "PUBLICATION_PARENT_CANARY"].filter((name) => process.env[name])
});
if (worker) {
  const fs = await import("node:fs");
  const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  record({
    kind: "worker-boundary",
    executable: process.execPath, args: process.execArgv, cwd: process.cwd(),
    environment: Object.keys(process.env).sort(),
    home: process.env.HOME, temporary: process.env.TMPDIR, cache: process.env.XDG_CACHE_HOME,
    snapshot: request.snapshot, snapshotPresent: fs.existsSync(request.snapshot)
    ,pid: process.pid,
    startTicks: process.platform === "linux" ? fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19] : null
  });
  const childProcess = (await import("node:child_process")).default;
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (file, ...args) => {
    if (/^npm(?:\\.cmd)?$/.test(basename(String(file)))) {
      fs.writeFileSync(${JSON.stringify(join(root, "forbidden"))}, "worker attempted npm CLI");
      throw new Error("worker attempted npm CLI");
    }
    return original(file, ...args);
  };
  (await import("node:module")).syncBuiltinESMExports();
}
let active = 0;
let maximumActive = 0;
let parentInterrupted = false;
process.once("exit", () => record({
  kind: "settled", active, maximumActive,
  worker
}));
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["https://registry.npmjs.org", "https://clawhub.ai"].includes(url.origin) ||
      (init.method ?? "GET") !== "GET") throw new Error("Unplanned fixture request");
  const headers = new Headers(init.headers);
  if ([...headers.keys()].some((key) => !["accept"].includes(key))) {
    throw new Error("Unexpected public registry request header");
  }
  record({ kind: "request", origin: url.origin, path: url.pathname });
  active += 1;
  maximumActive = Math.max(maximumActive, active);
  let released = false;
  const release = () => { if (!released) { released = true; active -= 1; } };
  if (${JSON.stringify(options.registry)} === "parent-interrupt") {
    if (!parentInterrupted) {
      parentInterrupted = true;
      const fallback = setTimeout(() => {
        record({ kind: "fixture-termination" });
        process.kill(process.pid, "SIGTERM");
      }, 1000);
      process.once(${JSON.stringify(options.parentSignal ?? "SIGTERM")}, () => {
        clearTimeout(fallback);
        record({ kind: "worker-termination" });
      });
      process.kill(process.ppid, ${JSON.stringify(options.parentSignal ?? "SIGTERM")});
    }
    return new Response(new ReadableStream({
      pull() {},
      cancel() { release(); }
    }));
  }
  const response = (body, status = 200) => new Response(new ReadableStream({
    async pull(stream) {
      if (${JSON.stringify(options.registry)} === "concurrency") await new Promise((resolve) => setTimeout(resolve, 5));
      stream.enqueue(new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)));
      stream.close();
      release();
    },
    cancel() { release(); }
  }), { status });
  if (url.origin === "https://registry.npmjs.org") {
    if (${JSON.stringify(options.registry)} === "advisory-deadline" && url.pathname === "/demo-runtime") {
      const now = Date.now;
      Date.now = () => now() + 600001;
    }
    if (${JSON.stringify(options.registry)} === "required-budget" ||
        (${JSON.stringify(options.registry)} === "advisory-budget" && url.pathname.startsWith("/advisory-"))) {
      init.signal.addEventListener("abort", () => record({ kind: "advisory-abort" }), { once: true });
      return response('{"versions":{"1.2.3":{}},"dist-tags":{"latest":"1.2.3"},"padding":"' + "x".repeat(15 * 1024 * 1024) + '"}');
    }
    if (${JSON.stringify(options.registry)} === "npm-absent" &&
        url.pathname === ${JSON.stringify(`/${encodeURIComponent(options.absentNpmPackage ?? "@openclaw/demo-plugin")}`)}) return response("", 404);
    if (${JSON.stringify(options.registry)} === "abort-peer") {
      if (url.pathname === "/openclaw") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return response("denied", 403);
      }
      return new Response(new ReadableStream({
        pull() {},
        cancel() { record({ kind: "body-cancelled" }); release(); }
      }));
    }
    if (${JSON.stringify(options.registry)} === "npm-error" ||
        (${JSON.stringify(options.registry)} === "advisory-error" && url.pathname === "/demo-runtime")) return response("denied", 403);
    const versions = ${JSON.stringify(options.registry)} === "npm-empty-history" ? {} : { "2026.9.3": {} };
    return response({ versions, "dist-tags": { latest: url.pathname === "/demo-runtime" ? "1.2.4" : "2026.9.3" } });
  }
  if (${JSON.stringify(options.registry)} === "clawhub-error") return response("denied", 403);
  if (${JSON.stringify(options.registry)} === "clawhub-absent") return response("", 404);
  if (url.pathname.endsWith("/publication")) {
    const name = decodeURIComponent(url.pathname.split("/")[4]);
    const publication = ${JSON.stringify(options.clawhubPublication ?? {})}[name];
    if (publication) return response({ name, version: ${JSON.stringify(version)}, ...publication });
  }
  if (url.pathname.includes("/versions/")) return response("", 404);
  if (url.pathname.endsWith("/trusted-publisher")) {
    return response({ trustedPublisher: ${JSON.stringify(options.registry)} === "missing-trust" ? null : {
      provider: ${JSON.stringify(options.registry)} === "prepared-trust" ? "other-provider" : "github-actions",
      repository: "openclaw/openclaw",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: null
    } });
  }
  return response({ name: "demo-plugin" });
};
`,
    );
  }
  if (options.legacyPlatforms) {
    write(
      tooling,
      ".github/workflows/openclaw-release-publish.yml",
      [
        "jobs:",
        "  publish:",
        "    steps:",
        "      - run: |",
        "          promote_windows_release_assets() {",
        "            dispatch_workflow windows-node-release.yml",
        "          }",
        "          promote_android_release_asset() {",
        "            dispatch_workflow android-release.yml",
        "          }",
        "  publish_docker:",
        "    uses: ./.github/workflows/docker-release.yml",
        "  publish_vcr:",
        "    uses: ./.github/workflows/vercel-container-registry-publish.yml",
        "",
      ].join("\n"),
    );
    write(tooling, "scripts/lib/release-publish-children.sh", "unrecognized unused shell data\n");
  }
  if (options.legacyPlatforms === "absent-helper" || options.fault === "platform-helper") {
    rmSync(join(tooling, "scripts/lib/release-publish-children.sh"));
  }
  if (options.sameSha) {
    const manifest = readJson(join(tooling, "package.json"));
    writeJson(tooling, "package.json", { ...manifest, version, dependencies: { yaml: "2.9.1" } });
    writePlugins(tooling);
    write(tooling, "apps/android/version.json", androidVersion);
  }
  let toolingSha = commit(tooling);
  let toolingFullRef = options.toolingFullRef ?? "refs/heads/main";
  let toolingRef = toolingFullRef.replace(/^refs\/heads\//u, "");
  if (toolingFullRef !== "refs/heads/main") {
    const base = toolingSha;
    write(tooling, "main-only.txt", "main-only\n");
    commit(tooling);
    git(tooling, "checkout", "-qb", toolingRef, base);
    write(tooling, "alpha-only.txt", "alpha-only\n");
    toolingSha = commit(tooling);
    check(
      spawnSync("git", ["merge-base", "--is-ancestor", toolingSha, "main"], {
        cwd: tooling,
      }).status,
    ).toBe(1);
  }
  if (options.qualification) {
    toolingRef = "release-ci/" + toolingSha.slice(0, 12) + "-123";
    toolingFullRef = "refs/heads/" + toolingRef;
    git(tooling, "branch", "-m", toolingRef);
  }
  if (options.sameSha) {
    target = tooling;
    targetSha = toolingSha;
  }
  for (const [fault, directory, path] of [
    ["candidate-object", target, "extensions/demo-plugin/README.md"],
    ["tooling-object", tooling, "scripts/release-plan-producer-core.mts"],
    ["platform-helper-object", tooling, "scripts/lib/release-publish-children.sh"],
    ["worker-object", tooling, "src/infra/clawhub-retry.ts"],
  ] as const) {
    if (options.fault === fault) {
      const oid = git(directory, "rev-parse", `HEAD:${path}`);
      rmSync(join(directory, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    }
  }
  for (const [fault, path, label] of [
    ["bootstrap", "scripts/release-plan-producer.mts", "bootstrap"],
    ["import", "scripts/lib/bounded-response.mjs", "import"],
    ["worker-import", "src/infra/clawhub-retry.ts", "worker import"],
  ] as const) {
    if (options.fault === fault) {
      write(tooling, path, readFileSync(join(tooling, path), "utf8") + `\n// changed ${label}\n`);
    }
  }
  if (options.fault === "dirty-candidate") {
    write(target, "extensions/demo-plugin/package.json", "not JSON");
  }
  if (options.fault === "dirty-android-pin") {
    writeJson(target, "apps/android/version.json", { version: "2026.8.1" });
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  const forbidden = join(root, "forbidden");
  const requests = join(root, "identity-requests.jsonl");
  for (const command of ["npm", "curl", "wget", "docker", "git-remote-fixture"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${forbidden}'\nexit 91\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/actions/artifacts/456") {
  require("node:fs").appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");
  process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(join(temporary, "upload-artifact.json"))}));
  process.exit(0);
}
if (${Boolean(options.qualification)}) {
  const fs = require("node:fs");
  const endpoint = args.find(arg => arg.startsWith("repos/"));
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");
  if (endpoint === "repos/openclaw/openclaw/actions/artifacts/70/zip") {
    if (${Boolean(options.legacyGhArchive)} && args.includes("--allow-escape-sequences")) {
      fs.writeSync(2, "unknown flag: --allow-escape-sequences\\n\\nUsage: gh api <endpoint> [flags]\\n");
      process.exit(1);
    }
    process.stdout.write(fs.readFileSync(${JSON.stringify(join(temporary, "qualification.zip"))}));
    process.exit(0);
  }
  const responses = JSON.parse(fs.readFileSync(${JSON.stringify(join(temporary, "qualification-responses.json"))}, "utf8"));
  const key = JSON.stringify(args);
  if (Object.hasOwn(responses, key)) { process.stdout.write(responses[key]); process.exit(0); }
}
const expected = ${JSON.stringify(
      toolingFullRef === "refs/heads/main"
        ? [
            "api",
            `repos/openclaw/openclaw/compare/${toolingSha}...main`,
            "--method",
            "GET",
            "--jq",
            "{status}",
          ]
        : ["api", `repos/openclaw/openclaw/git/ref/heads/${toolingRef}`, "--method", "GET"],
    )};
if (JSON.stringify(args) !== JSON.stringify(expected)) {
  require("node:fs").appendFileSync(${JSON.stringify(forbidden)}, "unexpected gh request");
  process.exit(91);
}
require("node:fs").appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");
process.stdout.write(${JSON.stringify(
      JSON.stringify(
        toolingFullRef === "refs/heads/main"
          ? { status: "identical" }
          : { ref: toolingFullRef, object: { type: "commit", sha: toolingSha } },
      ),
    )});
`,
    { mode: 0o755 },
  );
  const inputs = {
    ...Object.fromEntries(
      Object.entries(workflow.on.workflow_dispatch.inputs).map(([key, value]) => [
        key,
        value.default ?? "",
      ]),
    ),
    ref: targetSha,
    expected_sha: targetSha,
    target_context_ref: options.targetContextRef ?? "release/2026.9.9",
    release_profile: options.qualification ? "stable" : "beta",
    run_release_soak: Boolean(options.qualification),
    rerun_group: options.rerunGroup ?? (options.qualification ? "all" : "ci"),
    trusted_workflow_json: JSON.stringify({
      trustedWorkflow: { ref: toolingRef, fullRef: toolingFullRef, sha: toolingSha },
      validationPurpose: options.purpose ?? "publish",
      publicationSelection: options.selection === null ? null : (options.selection ?? selection),
    }),
  };
  if (options.qualification) {
    prepareSourceInventoryAdmission(
      temporary,
      tooling,
      inputs,
      targetSha,
      version,
      toolingRef,
      options.qualification,
    );
  }
  // These commands start after the existing target-identity owner; retain its
  // real version/context contract without claiming to exercise remote ancestry.
  check(resolveReleaseContextIdentity(inputs.target_context_ref, version)).not.toBeNull();
  const steps: Record<string, { outputs: Record<string, string>; outcome: string }> = {
    resolve: successfulStep({ sha: targetSha }),
    release_inputs: successfulStep({
      coverage_policy: "",
      target_version: version,
      skip_package_telegram_e2e: "false",
    }),
    tooling_identity: successfulStep({
      json: JSON.stringify({ fullRef: toolingFullRef, ref: toolingRef, sha: toolingSha }),
    }),
    filters: successfulStep({
      repo_live_suite_filter: "",
      qa_filter_seen: "",
      live_suite_filter: "",
      cross_os_suite_filter: "",
    }),
    candidate_request: successfulStep({ request_sha256: "" }),
    ...(options.sameSha || options.registry
      ? { frozen_selection: successfulStep({ parser_required: "false" }) }
      : {}),
  };
  const selectedWorkflow = parse(readFileSync(join(tooling, workflowPath), "utf8")) as Workflow;
  const context = {
    inputs,
    steps,
    env: selectedWorkflow.env,
    github: {
      workspace: root,
      sha: toolingSha,
      ref: toolingFullRef,
      ref_name: toolingRef,
      repository: "openclaw/openclaw",
      run_id: "123",
      run_attempt: 1,
      workflow_ref: `openclaw/openclaw/${workflowPath}@${toolingFullRef}`,
    },
  };
  const effects: string[] = [];
  let status = 0;
  let stderr = "";
  const resolveTarget = expectDefined(selectedWorkflow.jobs.resolve_target, "resolve_target job");
  const start = resolveTarget.steps.findIndex((step) => step.id === "release_inputs") + 1;
  const end = resolveTarget.steps.findIndex((step) => step.name === "Summarize target");
  check(start).toBeGreaterThan(0);
  check(end).toBeGreaterThan(start);
  for (const step of [
    expectDefined(
      resolveTarget.steps.find((candidate) => candidate.id === "publication_dispatch"),
      "dispatch decoder",
    ),
    expectDefined(
      resolveTarget.steps.find((candidate) => candidate.id === "candidate_request"),
      "candidate request",
    ),
    ...resolveTarget.steps.slice(start, end),
  ]) {
    // These controls exercise publication after accepted C/D prerequisites.
    // C/D's complete selected-contract fixture is maintained separately.
    if (
      (options.sameSha || options.registry) &&
      [
        "Plan frozen source admission",
        "Acquire selected contract objects",
        "Admit frozen source contracts",
      ].includes(step.name)
    ) {
      continue;
    }
    if (step.if && !evaluate(step.if, context)) {
      if (step.id) {
        steps[step.id] = { outcome: "skipped", outputs: {} };
      }
      continue;
    }
    if (step.name === "Upload immutable publication observations") {
      check(step.uses).toBe("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
      check(step.with).toEqual({
        name: "full-release-publication-observations-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/publication-observations.json",
        "if-no-files-found": "error",
      });
      const bytes = readFileSync(join(temporary, "publication-observations.json"));
      const digest = createHash("sha256")
        .update("fixture-upload-archive")
        .update(bytes)
        .digest("hex");
      writeFileSync(join(temporary, "uploaded-observations.json"), bytes);
      writeJson(temporary, "upload-artifact.json", {
        id: 456,
        name: "full-release-publication-observations-123-1",
        digest: `sha256:${digest}`,
        expired: false,
        size_in_bytes: bytes.length + 1024,
        workflow_run: { id: 123, head_sha: toolingSha, head_branch: toolingRef },
      });
      steps[step.id!] = {
        outcome: options.uploadFault === "failure" ? "failure" : "success",
        outputs: { "artifact-id": "456", "artifact-digest": digest },
      };
      if (options.uploadFault === "wrong-descriptor") {
        const metadataPath = join(temporary, "upload-artifact.json");
        const metadata = readJson(metadataPath);
        metadata.workflow_run.head_sha = "e".repeat(40);
        writeFileSync(metadataPath, JSON.stringify(metadata));
      }
      effects.push(step.name);
      continue;
    }
    if (!step.run) {
      continue;
    }
    if (step.name === "Provision trusted admission parser") {
      // Installation is a separate prerequisite proof; this fixture exercises its
      // actual selection predicate and the producer's verified runtime consumer.
      check(step["working-directory"]).toBe("workflow");
      check(step.run.trim()).toBe(
        "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts",
      );
      if (options.fault === "yaml") {
        mkdirSync(join(tooling, "node_modules"));
        for (const dependency of ["tsx", "typescript", "p-map"]) {
          symlinkSync(
            realpathSync(join(repo, "node_modules", dependency)),
            join(tooling, "node_modules", dependency),
            "dir",
          );
        }
        cpSync(realpathSync(join(repo, "node_modules/yaml")), join(tooling, "node_modules/yaml"), {
          recursive: true,
        });
        write(
          tooling,
          "node_modules/yaml/dist/index.js",
          readFileSync(join(tooling, "node_modules/yaml/dist/index.js"), "utf8") +
            "\n// changed YAML\n",
        );
      } else {
        symlinkSync(join(repo, "node_modules"), join(tooling, "node_modules"), "dir");
      }
      effects.push(step.name);
      continue;
    }
    const output = join(temporary, `output-${effects.length}`);
    const env: Record<string, string> = {
      PATH: [bin, dirname(nodeExecutable), process.env.PATH ?? ""].join(delimiter),
      HOME: root,
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: toolingSha,
      GITHUB_REF: toolingFullRef,
      GITHUB_REF_NAME: toolingRef,
      GITHUB_REF_TYPE: "branch",
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: temporary,
      NPM_TOKEN: "publication-parent-env-canary",
      PUBLICATION_PARENT_CANARY: "publication-parent-env-canary",
      ...(options.qualification ? { FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT: "1" } : {}),
      NODE_OPTIONS: "--no-warnings",
      NODE_PATH: join(root, "untrusted-modules"),
      HTTPS_PROXY: "http://proxy.invalid",
    };
    Object.assign(env, workflowEnv(step.env, context));
    if (
      step.name === "Finalize publication admission" &&
      options.uploadFault === "late-admission"
    ) {
      const observation = readJson(join(temporary, "publication-observations.json"));
      const clock = join(temporary, "upload-clock.cjs");
      writeFileSync(
        clock,
        `const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) {
    super(...(args.length ? args : [${Date.parse(observation.collectionCompletedAt) + 300_001}]));
  }
};
`,
      );
      env.NODE_OPTIONS = `--require=${clock}`;
    }
    if (options.sameSha) {
      for (const name of ["PUBLICATION_TARGET_ROOT", "ADMISSION_SELECTED_ROOT"]) {
        if (env[name]) {
          env[name] = target;
        }
      }
    }
    effects.push(step.name);
    const commandOptions = {
      cwd: step["working-directory"] ? join(root, step["working-directory"]) : root,
      env,
      encoding: "utf8" as const,
      timeout: 30_000,
    };
    const result =
      options.registry === "parent-interrupt"
        ? spawnSync(workflowBash, ["-c", step.run], commandOptions)
        : await processFixture.run(workflowBash, ["-c", step.run], commandOptions);
    if (result.error !== undefined && !(result.error instanceof Error)) {
      throw new Error("Unexpected publication command failure", { cause: result.error });
    }
    if (options.registry !== "parent-interrupt" && result.error) {
      throw result.error;
    }
    status = result.status ?? 1;
    stderr += result.stderr;
    if (result.error) {
      stderr += `${step.name}: ${result.error.message}`;
    }
    if (result.status !== 0) {
      stderr += `\nFailed step: ${step.name}\n${result.stdout}`;
    }
    if (status !== 0) {
      break;
    }
    if (step.id) {
      const outputs = workflowOutputs(output);
      steps[step.id] = { outputs, outcome: "success" };
    }
  }
  if (!options.sameSha) {
    check(existsSync(join(target, "node_modules"))).toBe(false);
  }
  check(existsSync(forbidden), stderr).toBe(false);
  const factPath = join(temporary, "publication-source-admission.json");
  const fact =
    existsSync(factPath) && readFileSync(factPath, "utf8").trim()
      ? (JSON.parse(readFileSync(factPath, "utf8")) as PublicationSourceFact)
      : undefined;
  const observationPath = join(temporary, "publication-observations.json");
  const observationText = existsSync(observationPath) ? readFileSync(observationPath, "utf8") : "";
  for (const privateValue of [
    root,
    "openclaw-publication-source-",
    "publication-parent-env-canary",
    '"packageDir"',
  ]) {
    check(observationText).not.toContain(privateValue);
  }
  const registryTrace = readJsonLines<{
    kind: string;
    bytes?: number;
    origin?: string;
    path?: string;
    worker?: boolean;
    inherited?: string[];
    active?: number;
    maximumActive?: number;
    executable?: string;
    args?: string[];
    cwd?: string;
    environment?: string[];
    home?: string;
    temporary?: string;
    cache?: string;
    snapshot?: string;
    snapshotPresent?: boolean;
    pid?: number;
    startTicks?: string;
  }>(registryCalls);
  const workerBoundary = registryTrace.find((entry) => entry.kind === "worker-boundary");
  let scratchCleanedByOwner = true;
  if (options.registry === "parent-interrupt" && workerBoundary) {
    // The admission parent settles only after its worker's close event; that joins
    // the worker's synchronous exit record and exact process before the shell returns.
    check(registryTrace).toContainEqual(settledWorker);
    const proc = `/proc/${workerBoundary.pid}/stat`;
    const live = () => {
      try {
        const fields = readFileSync(proc, "utf8").split(") ")[1]?.split(" ");
        return (
          fields?.[19] === workerBoundary.startTicks && !["Z", "X"].includes(fields?.[0] ?? "")
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    };
    check(live()).toBe(false);
    const snapshot = expectDefined(workerBoundary.snapshot, "owned worker snapshot");
    scratchCleanedByOwner = !existsSync(snapshot);
    if (!scratchCleanedByOwner) {
      const scratch = dirname(snapshot);
      check(workerBoundary.home).toBe(join(scratch, "worker-home"));
      check(scratch).toContain("openclaw-publication-source-");
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (workerBoundary) {
    check(workerBoundary).toMatchObject({
      executable: nodeExecutable,
      args: ["--import", pathToFileURL(join(tooling, "scripts/tsx.mjs")).href],
      cwd: tooling,
      snapshotPresent: true,
      environment: [
        "PATH",
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "XDG_CACHE_HOME",
        "LANG",
        "LC_ALL",
        "TSX_DISABLE_CACHE",
        ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []),
      ].toSorted(),
    });
    for (const path of [
      workerBoundary.snapshot,
      workerBoundary.home,
      workerBoundary.temporary,
      workerBoundary.cache,
    ]) {
      check(existsSync(expectDefined(path, "worker isolated path"))).toBe(false);
    }
    check(stderr).not.toContain("publication-parent-env-canary");
    check(stderr).not.toContain(root);
  }
  return {
    status,
    stderr,
    effects,
    steps,
    fact,
    targetSha,
    toolingSha,
    observations: observationText ? JSON.parse(observationText) : undefined,
    observationText,
    uploadedObservations: existsSync(join(temporary, "uploaded-observations.json"))
      ? readFileSync(join(temporary, "uploaded-observations.json"), "utf8")
      : undefined,
    publicationAdmission: existsSync(join(temporary, "publication-admission.json"))
      ? readJson(join(temporary, "publication-admission.json"))
      : undefined,
    scratchCleanedByOwner,
    firstHopJobs: options.registry
      ? ["normal_ci", "prepare_npm_package"].filter((id) => {
          const job = expectDefined(workflow.jobs[id], "first-hop job");
          check([job.needs].flat()).toContain("resolve_target");
          return evaluate(expectDefined(job.if, "first-hop condition"), {
            ...context,
            needs: {
              resolve_target: {
                result: status === 0 ? "success" : "failure",
                outputs: {
                  sha: targetSha,
                  target_version: steps.release_inputs!.outputs.target_version,
                  candidate_required: steps.candidate_request!.outputs.required,
                },
              },
              plugin_compatibility_readiness: { result: "success" },
              evidence_reuse: { result: "skipped", outputs: { reuse: "false" } },
            },
          });
        })
      : [],
    registryCalls: registryTrace,
    requests: readJsonLines<string[]>(requests),
  };
}

const stable = "2026.9.9";
const beta = "2026.9.9-beta.1";
const extended = "2026.8.33";
const pluginName = "@openclaw/demo-plugin";
const coreName = "@openclaw/gateway-client";
const releaseRef = "release/2026.9.9";

function npmBootstrap(
  name: string,
  admitted: boolean,
  overrides: Partial<{
    version: string;
    pluginVersion: string;
    route: string;
    npmDistTag: string;
    absentNpmPackage: "openclaw" | "@openclaw/demo-plugin" | "@openclaw/gateway-client";
    registry: "npm-absent" | "npm-empty-history";
    npmOnlyPlugin: boolean;
  }> = {},
) {
  return {
    name,
    admitted,
    version: stable,
    pluginVersion: stable,
    route: "normal",
    npmDistTag: "latest",
    absentNpmPackage: pluginName,
    registry: "npm-absent",
    npmOnlyPlugin: false,
    ...overrides,
  } as const;
}

describe("FRV required registry admission", () => {
  publicationIt.concurrent.for([
    undefined,
    "failure",
    "wrong-descriptor",
    "late-admission",
  ] as const)(
    "binds actual post-upload admission without rewriting uploaded observations: %s",
    withCase(async (uploadFault, processFixture, check) => {
      const result = await fixture(processFixture, check, { registry: "healthy", uploadFault });
      check(result.uploadedObservations).toBe(result.observationText);
      check(result.effects.indexOf("Upload immutable publication observations")).toBeLessThan(
        result.effects.indexOf("Finalize publication admission"),
      );
      if (uploadFault) {
        check(result.status).not.toBe(0);
        check(result.stderr).toMatch(/upload|freshness/u);
        check(result.publicationAdmission).toBeUndefined();
        check(result.firstHopJobs).toEqual([]);
      } else {
        check(result.status, result.stderr).toBe(0);
        const admission = result.publicationAdmission.publicationAdmission;
        check(admission.observations).toEqual(result.observations);
        check(admission.binding.status).toBe("admitted-for-validation");
        check(admission.binding.artifact.name).toBe("full-release-publication-observations-123-1");
        check(Date.parse(admission.binding.admittedAt)).toBeGreaterThanOrEqual(
          Date.parse(result.observations.collectionCompletedAt),
        );
        check(result.firstHopJobs).toEqual(["normal_ci"]);
      }
    }),
  );
  publicationIt.concurrent.for([
    ["healthy", "normal", stable, "latest", ["normal_ci", "prepare_npm_package"]],
    ["npm-empty-history", "normal", stable, "latest", []],
    ["npm-error", "normal", stable, "latest", []],
    ["clawhub-error", "normal", stable, "latest", []],
    ["prepared-trust", "prepared", stable, "latest", []],
  ] as const)(
    "keeps selected fanout closed for %s through %s",
    { timeout: 30_000 },
    withCase(
      async ([registry, route, version, npmDistTag, expectedJobs], processFixture, check) => {
        const result = await fixture(processFixture, check, {
          registry,
          rerunGroup: "all",
          version,
          targetContextRef: releaseRef,
          selection: { ...selection, route, npmDistTag },
        });
        check(result.targetSha).not.toBe(result.toolingSha);
        check(result.effects).toContain("Provision trusted admission parser");
        check(result.effects).toContain("Admit publication source");
        check(result.registryCalls).toContainEqual(isolatedWorker);
        const actualRequests = result.registryCalls.filter((entry) => entry.kind === "request");
        check(actualRequests.length).toBeGreaterThan(0);
        if (registry === "healthy") {
          const npm = "https://registry.npmjs.org";
          const clawhub = "https://clawhub.ai";
          check(actualRequests).toEqual(
            expect.arrayContaining(
              [
                [npm, "/openclaw"],
                [npm, "/%40openclaw%2Fdemo-plugin"],
                [clawhub, "/api/v1/packages/%40openclaw%2Fdemo-plugin"],
                [clawhub, "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher"],
                [clawhub, `/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/${version}`],
              ].map(([origin, path]) => ({ kind: "request", origin, path })),
            ),
          );
          check(actualRequests).toHaveLength(6);
          check(result.observations).toMatchObject({
            sourceDigest: result.fact?.digest,
            pendingAuthority: [],
          });
        }
        check(result.firstHopJobs, result.stderr).toEqual(expectedJobs);
        check(result.status, result.stderr).toBe(registry === "healthy" ? 0 : 1);
        if (registry === "clawhub-error") {
          check(result.stderr).toContain("required ClawHub observation http-403");
        }
      },
    ),
  );
});

describe("FRV observation worker boundary", () => {
  publicationIt.concurrent(
    "retains publication states through isolated observation, planning, and artifact admission",
    withCommand(async (processFixture, check) => {
      const publications: Record<string, ClawHubPublicationState> = {
        [pluginName]: { state: "absent" },
        "@openclaw/demo-1": { state: "published" },
        "@openclaw/demo-2": { state: "pending", stage: "staging" },
        "@openclaw/demo-3": { state: "pending", stage: "checks", attemptId: "attempt_checks" },
        "@openclaw/demo-4": {
          state: "pending",
          stage: "finalization",
          attemptId: "attempt_final",
        },
        "@openclaw/demo-5": { state: "failed", recoverable: true, attemptId: "attempt_recover" },
        "@openclaw/demo-6": { state: "failed", recoverable: false },
      };
      const result = await fixture(processFixture, check, {
        registry: "healthy",
        pluginCount: 7,
        clawhubPublication: publications,
      });
      check(result.status, result.stderr).toBe(0);
      const { observations } = result;
      check(observations.plans.clawhub).toMatchObject({
        candidates: [pluginName],
        skippedPublished: ["@openclaw/demo-1"],
        pendingPublication: ["@openclaw/demo-2", "@openclaw/demo-3", "@openclaw/demo-4"],
        failedPublication: ["@openclaw/demo-5", "@openclaw/demo-6"],
      });
      for (const [name, publication] of Object.entries(publications)) {
        const entry = { name, publication, alreadyPublished: publication.state === "published" };
        check(observations.clawhub).toContainEqual(
          expect.objectContaining({
            name,
            state: expect.objectContaining({
              publication,
              alreadyPublished: entry.alreadyPublished,
            }),
          }),
        );
        check(observations.plans.clawhub.all).toContainEqual(expect.objectContaining(entry));
      }
      const source = expectDefined(result.fact, "publication source");
      const shells = structuredClone(observations);
      for (const row of shells.clawhub) {
        if (["pending", "failed"].includes(row.state.publication.state)) {
          row.state.hasTrustedPublisher = false;
          row.state.trustedPublisher = null;
        }
      }
      check(createPublicationObservations(source, shells)).toEqual(shells);
      const malformed = structuredClone(observations);
      delete malformed.clawhub[0].state.publication;
      check(() => createPublicationObservations(source, malformed)).toThrow("outcome mismatch");
      const missingBucket = structuredClone(observations);
      delete missingBucket.plans.clawhub.pendingPublication;
      check(() => createPublicationObservations(source, missingBucket)).toThrow("incomplete");
      const republish = structuredClone(observations);
      republish.plans.clawhub.candidates.push("@openclaw/demo-2");
      check(() => createPublicationObservations(source, republish)).toThrow("outcome mismatch");
      const legacy = structuredClone(observations);
      for (const row of legacy.clawhub) {
        delete row.state.publication;
      }
      for (const row of legacy.plans.clawhub.all) {
        delete row.publication;
      }
      delete legacy.plans.clawhub.pendingPublication;
      delete legacy.plans.clawhub.failedPublication;
      legacy.plans.clawhub.candidates = legacy.plans.clawhub.all
        .filter((row: { alreadyPublished: boolean }) => !row.alreadyPublished)
        .map((row: { name: string }) => row.name);
      const originalBytes = JSON.stringify(legacy);
      check(createPublicationObservations(source, legacy)).toEqual(legacy);
      check(JSON.stringify(legacy)).toBe(originalBytes);
    }),
  );
  publicationIt.concurrent.for([
    npmBootstrap("root package", false, { absentNpmPackage: "openclaw" }),
    npmBootstrap("core package", false, { absentNpmPackage: coreName }),
    npmBootstrap("stable plugin on latest", true),
    npmBootstrap("beta plugin with stable parent", true, { pluginVersion: beta }),
    npmBootstrap("stable plugin with beta parent", false, { version: beta, npmDistTag: "beta" }),
    npmBootstrap("prepared stable plugin", true, { route: "prepared" }),
    npmBootstrap("prepared npm-only beta plugin", true, {
      version: beta,
      pluginVersion: beta,
      route: "prepared",
      npmDistTag: "beta",
      npmOnlyPlugin: true,
    }),
    npmBootstrap("extended plugin", false, {
      version: extended,
      pluginVersion: extended,
      route: "extended-stable",
      npmDistTag: "extended-stable",
    }),
    npmBootstrap("beta empty history", false, {
      version: beta,
      pluginVersion: beta,
      npmDistTag: "beta",
      registry: "npm-empty-history",
    }),
  ])(
    "matches npm bootstrap writer ownership for $name",
    { timeout: 30_000 },
    withCase(
      async ({ name: _name, admitted, route, npmDistTag, ...options }, processFixture, check) => {
        const { version, pluginVersion, absentNpmPackage, registry } = options;
        const result = await fixture(processFixture, check, {
          ...options,
          includeCorePackage: absentNpmPackage === coreName,
          targetContextRef: route === "extended-stable" ? `extended-stable/${version}` : releaseRef,
          rerunGroup: "all",
          selection: { ...selection, route, npmDistTag },
        });
        check(result.effects).toContain("Admit publication source");
        check(result.registryCalls).toContainEqual({
          kind: "request",
          origin: "https://registry.npmjs.org",
          path: `/${encodeURIComponent(absentNpmPackage)}`,
        });
        check(result.firstHopJobs, result.stderr).toEqual(
          admitted ? ["normal_ci", "prepare_npm_package"] : [],
        );
        check(result.status, result.stderr).toBe(admitted ? 0 : 1);
        if (admitted) {
          check(result.observations.pendingAuthority).toEqual([
            {
              registry: "npm",
              name: absentNpmPackage,
              action: "owner-preparation-and-access",
              status: "unresolved",
            },
          ]);
          check(result.observations.npm).toContainEqual(
            expect.objectContaining({
              name: absentNpmPackage,
              version: pluginVersion,
              outcome: "observed",
              state: expect.objectContaining({
                packageExists: false,
                hasVersionHistory: false,
                selectedVersionExists: false,
              }),
            }),
          );
          check(result.observations).not.toHaveProperty("admittedAt");
        } else {
          check(result.observations).toBeUndefined();
          check(result.stderr).toContain(
            registry === "npm-empty-history" ? "http-200" : "unsupported-bootstrap",
          );
        }
      },
    ),
  );

  publicationIt.concurrent(
    "keeps required observations when only advisories exhaust the aggregate byte budget",
    withCommand(async (processFixture, check) => {
      const result = await fixture(processFixture, check, {
        registry: "advisory-budget",
        advisoryCount: 20,
      });
      check(result.status, result.stderr).toBe(0);
      check(
        result.observations.npm.filter((entry: { required: boolean }) => entry.required),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "openclaw", outcome: "observed" }),
          expect.objectContaining({ name: pluginName, outcome: "observed" }),
        ]),
      );
      check(result.observations.npm).toHaveLength(22);
      check(result.observations.plans.npm.warnings.length).toBeGreaterThan(0);
      const abortAt = result.registryCalls.findIndex((entry) => entry.kind === "advisory-abort");
      check(abortAt).toBeGreaterThan(0);
      check(
        result.registryCalls.slice(abortAt + 1).filter((entry) => entry.kind === "request"),
      ).toEqual([]);
      check(
        result.registryCalls.filter((entry) => entry.path?.startsWith("/advisory-")).length,
      ).toBeLessThan(20);
      check(result.registryCalls).toContainEqual(settledWorker);
    }),
    30_000,
  );

  publicationIt.runIf(process.platform === "linux").for(["SIGINT", "SIGTERM"] as const)(
    "forwards parent-only termination %s and joins the worker before snapshot cleanup",
    { timeout: 30_000 },
    withCase(async (parentSignal, processFixture, check) => {
      const result = await fixture(processFixture, check, {
        registry: "parent-interrupt",
        parentSignal,
      });
      check(result.registryCalls).not.toContainEqual({ kind: "fixture-termination" });
      check(result.registryCalls).toContainEqual({ kind: "worker-termination" });
      check(result.scratchCleanedByOwner).toBe(true);
      check(result.status, result.stderr).toBe(1);
      check(result.observations).toBeUndefined();
    }),
  );

  publicationIt.concurrent.for(["required-budget", "advisory-deadline"] as const)(
    "keeps %s fatal rather than downgrading it to a latest warning",
    { timeout: 30_000 },
    withCase(async (registry, processFixture, check) => {
      const result = await fixture(processFixture, check, {
        registry,
        ...(registry === "required-budget" ? { pluginCount: 20 } : { latestDependency: true }),
      });
      check(result, result.stderr).toMatchObject(unobservedFailure);
      check(result.stderr).toContain(
        registry === "required-budget" ? "response-too-large" : "cancelled-or-timeout",
      );
      check(result.registryCalls).toContainEqual(settledWorker);
    }),
  );

  publicationIt.concurrent.for([
    ["clawhub-absent", "normal", true, "clawhub", "bootstrap-and-owner-access"],
    ["clawhub-absent", "prepared", false, "clawhub", ""],
    ["missing-trust", "normal", true, "clawhub", "publisher-repair"],
    ["missing-trust", "prepared", false, "clawhub", ""],
  ] as const)(
    "distinguishes %s on %s without claiming downstream authority",
    { timeout: 30_000 },
    withCase(async ([registry, route, admitted, registryName, action], processFixture, check) => {
      const result = await fixture(processFixture, check, {
        registry,
        selection: { ...selection, route },
      });
      check(result.status, result.stderr).toBe(admitted ? 0 : 1);
      check(result.registryCalls).toContainEqual(isolatedWorker);
      if (admitted) {
        check(result.observations.pendingAuthority).toContainEqual({
          registry: registryName,
          name: pluginName,
          action,
          status: "unresolved",
        });
        check(result.observations).not.toHaveProperty("admittedAt");
      } else {
        check(result).toMatchObject({ observations: undefined, firstHopJobs: [] });
      }
    }),
  );

  publicationIt.concurrent.for(["concurrency", "advisory-error"] as const)(
    "shares required/advisory reads across both planners with %s",
    { timeout: 30_000 },
    withCase(async (registry, processFixture, check) => {
      const count = registry === "concurrency" ? 10 : 1;
      const result = await fixture(processFixture, check, {
        registry,
        pluginCount: count,
        latestDependency: true,
      });
      check(result.status, result.stderr).toBe(0);
      const reads = result.registryCalls.filter((entry) => entry.kind === "request");
      check(reads).toHaveLength(5 * count + 2);
      check(reads.filter((entry) => entry.path === "/demo-runtime")).toHaveLength(1);
      const settlement = result.registryCalls.find(
        (entry) => entry.kind === "settled" && entry.worker,
      );
      check(settlement).toMatchObject({ active: 0 });
      check(settlement?.maximumActive).toBeLessThanOrEqual(8);
      if (registry === "concurrency") {
        check(settlement?.maximumActive).toBe(8);
      }
      for (const plan of [result.observations.plans.npm, result.observations.plans.clawhub]) {
        check(plan.all).toHaveLength(count);
        check(plan.warnings).toHaveLength(count);
      }
      if (registry === "advisory-error") {
        check(result.observations.npm).toContainEqual(
          expect.objectContaining({
            name: "demo-runtime",
            required: false,
            outcome: "unavailable",
            error: "http-403",
          }),
        );
      }
    }),
  );

  publicationIt.concurrent(
    "aborts and drains a pending peer body after a required failure",
    withCommand(async (processFixture, check) => {
      const result = await fixture(processFixture, check, { registry: "abort-peer" });
      check(result, result.stderr).toMatchObject(unobservedFailure);
      check(result.stderr).toContain("required npm observation http-403");
      check(result.registryCalls).toContainEqual({ kind: "body-cancelled" });
      check(result.registryCalls).toContainEqual(settledWorker);
    }),
    30_000,
  );

  publicationIt.concurrent(
    "keeps advisory warning volume from blocking validation",
    withCommand(async (processFixture, check) => {
      const result = await fixture(processFixture, check, {
        registry: "advisory-error",
        pluginCount: 80,
        latestDependency: true,
      });
      check(result.status, result.stderr).toBe(0);
      check(result.observations.plans.npm.warnings).toHaveLength(80);
      check(result.observations.plans.clawhub.warnings).toHaveLength(80);
      check(result.registryCalls.filter((entry) => entry.path === "/demo-runtime")).toHaveLength(1);
    }),
    30_000,
  );

  publicationIt.concurrent.for([
    "worker-object",
    "worker-import",
    "candidate-object",
    "yaml",
  ] as const)(
    "rejects %s before any public read",
    { timeout: 30_000 },
    withCase(async (fault, processFixture, check) => {
      const result = await fixture(processFixture, check, { registry: "healthy", fault });
      check(result, result.stderr).toMatchObject(unobservedFailure);
      check(result.registryCalls.filter((entry) => entry.kind === "request")).toEqual([]);
    }),
  );
});

describe("FRV publication source admission", () => {
  const rejection = (
    name: string,
    error: string | RegExp,
    options: NonNullable<Parameters<typeof fixture>[2]>,
    boundaries: { noRegistry?: boolean; noParser?: boolean } = {},
  ) => ({ name, error, options, ...boundaries });
  const mismatchedSelection = "publication selection does not match";
  const androidPinError = "must pin an exact YYYY.M.PATCH Android version";
  publicationIt.concurrent.for([
    rejection(
      "alpha inventory through divergent tooling",
      "Alpha releases are retired;",
      {
        toolingFullRef: "refs/heads/tideclaw/alpha/2026-09-13-1200Z",
        version: "2026.9.9-alpha.1",
        targetContextRef: "v2026.9.9-alpha.1",
        selection: { ...selection, route: "alpha", npmDistTag: "alpha" },
      },
      { noRegistry: true },
    ),
    rejection("committed publisher metadata defect", "README.md must exist", { fault: "readme" }),
    rejection("invalid unselected plugin before projection", "README.md must exist", {
      fault: "unselected",
      selection: selectedPlugins(pluginName),
    }),
    rejection("unknown selected package", /unknown|not found|not publishable/iu, {
      selection: selectedPlugins("@openclaw/unknown"),
    }),
    rejection(
      "core plus selected plugins",
      "core publication requires all-publishable plugins",
      {
        selection: { ...selectedPlugins(pluginName), publishOpenclawNpm: true },
      },
      { noParser: true },
    ),
    rejection("beta to latest", mismatchedSelection, {
      version: beta,
      targetContextRef: releaseRef,
      selection: { ...selection, npmDistTag: "latest" },
    }),
    rejection("alpha to beta", "Alpha releases are retired;", {
      version: "2026.9.9-alpha.1",
      targetContextRef: "v2026.9.9-alpha.1",
      selection: { ...selection, npmDistTag: "beta" },
    }),
    rejection("extended-stable to beta", mismatchedSelection, {
      version: extended,
      targetContextRef: "extended-stable/2026.8.33",
      selection: { ...selection, npmDistTag: "beta" },
    }),
    rejection("prefixed Android pin", androidPinError, { androidPin: "v2026.9.9" }),
    rejection("multiline Android pin", androidPinError, { androidPin: "2026.9.9\nextra=value" }),
  ])(
    "rejects $name before source admission",
    { timeout: 30_000 },
    withCase(async ({ options, error, noRegistry, noParser }, command, check) => {
      const result = await fixture(command, check, options);
      check(result, result.stderr).toMatchObject({ status: 1, fact: undefined });
      if (typeof error === "string") {
        check(result.stderr).toContain(error);
      } else {
        check(result.stderr).toMatch(error);
      }
      if (noRegistry) {
        check(result.registryCalls).toEqual([]);
      }
      if (noParser) {
        check(result.effects).not.toContain("Provision trusted admission parser");
      }
    }),
  );

  publicationIt.concurrent(
    "falls back when the runner gh lacks binary-output sanitization",
    withCommand(async (processFixture, check) => {
      const result = await fixture(processFixture, check, {
        qualification: "valid",
        legacyGhArchive: true,
        registry: "healthy",
      });
      check(result.status, result.stderr).toBe(0);
      const archiveRequests = result.requests.filter((args) =>
        args.includes("repos/openclaw/openclaw/actions/artifacts/70/zip"),
      );
      check(archiveRequests).toHaveLength(2);
      check(archiveRequests[0]).toContain("--allow-escape-sequences");
      check(archiveRequests[1]).not.toContain("--allow-escape-sequences");
    }),
  );

  publicationIt.concurrent.for(["valid", "wrong-input", "wrong-archive", "expired"] as const)(
    "executes admitted candidate-owned inventory end to end (%s)",
    withCase(async (qualification, processFixture, check) => {
      const result = await fixture(processFixture, check, { qualification, registry: "healthy" });
      check(result.status, result.stderr).toBe(qualification === "valid" ? 0 : 1);
      if (qualification === "valid") {
        check(result.fact).toMatchObject({
          status: "source-admitted",
          tooling: { ref: expect.stringMatching(/^refs\/heads\/release-ci\//u) },
        });
        check(result.fact?.tooling.sha).toBe(result.fact?.candidateSha);
        check(result.fact?.qualificationAdmission).toMatchObject({
          workflowSha: "b".repeat(40),
          workflowFullRef: "refs/heads/main",
        });
      } else {
        check(result.fact).toBeUndefined();
        check(result.registryCalls.filter((entry) => entry.kind === "request")).toEqual([]);
        check(result.firstHopJobs).toEqual([]);
      }
    }),
  );

  publicationIt.concurrent(
    "indexes an admitted near-limit incompressible source pack",
    withCommand(async (processFixture, check) => {
      const result = await fixture(processFixture, check, {
        nearLimitPack: true,
        registry: "healthy",
      });
      check(result.status, result.stderr).toBe(0);
      const raw = expectDefined(
        result.registryCalls.find((entry) => entry.kind === "raw-source")?.bytes,
        "raw source bytes",
      );
      check(raw).toBeGreaterThan(64 * 1024 * 1024 - 8192);
      check(raw).toBeLessThanOrEqual(64 * 1024 * 1024);
      check(
        result.registryCalls.find((entry) => entry.kind === "packed-source")?.bytes,
      ).toBeGreaterThan(64 * 1024 * 1024);
      check(result.registryCalls.filter((entry) => entry.kind === "indexed-source")).toHaveLength(
        2,
      );
      check(result.fact?.status).toBe("source-admitted");
      check(result.registryCalls.filter((entry) => entry.kind === "request")).toHaveLength(6);
    }),
    30_000,
  );
  publicationIt.concurrent.for([
    ["size-missing", "invalid publication source object-size response"],
    ["size-wrong-oid", "invalid publication source object-size response"],
    ["size-unterminated", "invalid publication source object-size response"],
    ["size-extra", "invalid publication source object-size response"],
    ["size-individual-limit", "metadata exceeds byte limit"],
    ["size-total-limit", "metadata exceeds byte limit"],
    ["size-limit-before-truncated", "metadata exceeds byte limit"],
  ] as const)(
    "rejects %s before packing or registry reads",
    { timeout: 30_000 },
    withCase(async ([fault, error], processFixture, check) => {
      const result = await fixture(processFixture, check, { fault, registry: "healthy" });
      check(result.status, result.stderr).toBe(1);
      check(result.stderr).toContain(error);
      check(result.fact).toBeUndefined();
      check(
        result.registryCalls.filter((entry) => entry.kind === "object-size-batch"),
      ).toHaveLength(1);
      check(result.registryCalls.filter((entry) => entry.kind === "source-pack")).toEqual([]);
      check(result.registryCalls.filter((entry) => entry.kind === "request")).toEqual([]);
      check(result.firstHopJobs).toEqual([]);
    }),
  );
  publicationIt.concurrent.for([
    [stable, "normal", false],
    ["2026.9.9-1", "prepared", true],
  ] as const)(
    "preserves beta-first %s publication through %s with Windows=%s",
    { timeout: 30_000 },
    withCase(async ([version, route, windows], processFixture, check) => {
      const result = await fixture(processFixture, check, {
        version,
        targetContextRef: `v${version}`,
        selection: { ...(windows ? windowsSelection : selection), route, npmDistTag: "beta" },
      });
      check(result.status, result.stderr).toBe(0);
      check(result.fact).toMatchObject({
        status: "source-admitted",
        publicationSelection: { route, npmDistTag: "beta" },
        projection: { version },
      });
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      check(platforms).toContainEqual({
        id: "linux",
        source: ".github/workflows/linux-app-release-request.yml",
      });
      if (windows) {
        check(platforms).toContainEqual(platform("windows"));
      } else {
        check(platforms).not.toContainEqual(platform("windows"));
      }
    }),
  );

  publicationIt.concurrent.for<
    [
      toolingFullRef: string,
      version: string,
      route: string,
      npmDistTag: string,
      targetContextRef: string,
    ]
  >([
    ["refs/heads/release/2026.9.9", stable, "normal", "beta", releaseRef],
    [
      "refs/heads/extended-stable/2026.8.33",
      extended,
      "extended-stable",
      "extended-stable",
      "extended-stable/2026.8.33",
    ],
  ])(
    "admits canonical branch inventory through actual divergent %s tooling",
    { timeout: 30_000 },
    withCase(
      async (
        [toolingFullRef, version, route, npmDistTag, targetContextRef],
        processFixture,
        check,
      ) => {
        const result = await fixture(processFixture, check, {
          toolingFullRef,
          version,
          targetContextRef,
          selection: { ...selection, route, npmDistTag },
        });
        check(result.status, result.stderr).toBe(0);
        check(result.targetSha).not.toBe(result.toolingSha);
        check(result.fact).toMatchObject({
          status: "source-admitted",
          tooling: { ref: toolingFullRef, sha: result.toolingSha },
          projection: { version },
        });
        check(result.requests).toEqual([
          [
            "api",
            `repos/openclaw/openclaw/git/ref/${toolingFullRef.slice("refs/".length)}`,
            "--method",
            "GET",
          ],
          ["api", "repos/openclaw/openclaw/actions/artifacts/456"],
        ]);
      },
    ),
  );

  publicationIt.concurrent.for([false, true])(
    "admits complete committed inventory with same SHA=%s",
    { timeout: 30_000 },
    withCase(async (sameSha, processFixture, check) => {
      const result = await fixture(processFixture, check, {
        sameSha,
        fault: sameSha ? undefined : "dirty-candidate",
      });
      check(result.status, result.stderr).toBe(0);
      check(result.fact).toMatchObject({
        status: "source-admitted",
        candidateSha: result.targetSha,
        tooling: { sha: result.toolingSha },
        coverage: { rerun_group: "ci", release_profile: "beta", run_release_soak: "false" },
      });
      check(result.fact?.projection?.packages).toEqual(
        expect.arrayContaining([
          { name: "openclaw", version: stable, targets: ["npm"] },
          { name: pluginName, version: stable, targets: ["clawhub", "npm"] },
        ]),
      );
      check(result.fact?.projection?.platforms).toEqual(
        expect.arrayContaining([
          { id: "docker", source: ".github/workflows/docker-release.yml" },
          { id: "linux", source: ".github/workflows/linux-app-release-request.yml" },
          { id: "vcr", source: ".github/workflows/vercel-container-registry-publish.yml" },
        ]),
      );
      check(result.effects).toContain("Provision trusted admission parser");
    }),
  );

  publicationIt.concurrent.for(["diagnostic"])(
    "retains %s without publication bootstrap or added installation",
    { timeout: 30_000 },
    withCase(async (purpose, processFixture, check) => {
      const result = await fixture(processFixture, check, {
        purpose,
        selection: null,
        fault: "readme",
      });
      check(result.status, result.stderr).toBe(0);
      check(result.fact).toMatchObject({
        status: "not-applicable",
        validationPurpose: purpose,
        inventoryDigest: null,
        projection: null,
      });
      check(result.effects).not.toContain("Provision trusted admission parser");
      check(result.effects).not.toContain("Acquire publication source metadata");
      check(result.publicationAdmission).toMatchObject({
        publicationAdmissionContract: "1",
        publicationAdmission: null,
      });
      check(result.observations).toBeUndefined();
      check(result.registryCalls).toEqual([]);
    }),
  );

  publicationIt.concurrent.for([
    "candidate-object",
    "tooling-object",
    "bootstrap",
    "import",
    "yaml",
    "symlink",
    "non-utf8",
    "platform-helper",
    "platform-helper-object",
  ] as const)(
    "fails closed for %s without selected execution or registry access",
    { timeout: 30_000 },
    withCase(async (fault, processFixture, check) => {
      const result = await fixture(processFixture, check, { fault });
      check(result.status, result.stderr).toBe(1);
      check(result.fact).toBeUndefined();
      check(result.stderr).not.toContain("MODULE_NOT_FOUND");
    }),
  );

  publicationIt.concurrent.for([
    [beta, "normal", "beta", releaseRef, false],
    [stable, "normal", "latest", releaseRef, true],
    ["2026.9.9-1", "normal", "beta", "v2026.9.9-1", true],
  ] as const)(
    "matches actual Windows publication selection for %s through %s to %s",
    { timeout: 30_000 },
    withCase(
      async ([version, route, npmDistTag, targetContextRef, expected], processFixture, check) => {
        const publisher = parse(
          readFileSync(join(repo, ".github/workflows/openclaw-release-publish.yml"), "utf8"),
        ) as Workflow;
        const enabled = evaluate(
          expectDefined(publisher.jobs.publish_windows?.if, "Windows predicate"),
          {
            inputs: {
              tag: `v${version}`,
              npm_dist_tag: npmDistTag,
              windows_node_tag: windowsSelection.windowsNodeTag,
              windows_node_installer_digests: JSON.stringify(
                windowsSelection.windowsNodeInstallerDigests,
              ),
            },
            needs: { finalize_github_release: { result: "success" } },
          },
        );
        check(enabled).toBe(expected);
        const result = await fixture(processFixture, check, {
          version,
          targetContextRef,
          selection: { ...windowsSelection, route, npmDistTag },
        });
        if (!enabled) {
          check(result.status, result.stderr).toBe(1);
          check(result.stderr).toContain("Windows assets require a stable publication");
          check(result.effects).toContain("Admit publication source");
          check(result.fact).toBeUndefined();
          return;
        }
        check(result.status, result.stderr).toBe(0);
        check(result.fact?.projection?.platforms).toContainEqual({
          id: "windows",
          source: ".github/workflows/windows-node-release.yml",
        });
      },
    ),
  );

  publicationIt.concurrent.for(["absent-helper", "dormant-helper"] as const)(
    "preserves inline platform tooling with %s",
    { timeout: 30_000 },
    withCase(async (legacyPlatforms, processFixture, check) => {
      const result = await fixture(processFixture, check, {
        legacyPlatforms,
        selection: windowsSelection,
      });
      check(result.status, result.stderr).toBe(0);
      check(result.fact?.projection?.platforms).toEqual([
        { id: "android", source: ".github/workflows/android-release.yml" },
        { id: "docker", source: ".github/workflows/docker-release.yml" },
        { id: "vcr", source: ".github/workflows/vercel-container-registry-publish.yml" },
        { id: "windows", source: ".github/workflows/windows-node-release.yml" },
      ]);
    }),
  );

  publicationIt.concurrent.for([
    [beta, "normal", "beta", releaseRef],
    [extended, "extended-stable", "extended-stable", "extended-stable/2026.8.33"],
  ])(
    "admits %s through the existing %s source policy",
    { timeout: 30_000 },
    withCase(async ([version, route, npmDistTag, targetContextRef], processFixture, check) => {
      const result = await fixture(processFixture, check, {
        version,
        targetContextRef,
        selection: { ...selection, route, npmDistTag },
      });
      check(result.status, result.stderr).toBe(0);
      check(result.fact).toMatchObject({ projection: { version }, targetContextRef });
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      check(platforms).not.toContainEqual(platform("linux"));
      if (route === "extended-stable") {
        check(result.fact?.projection?.packages).toEqual(
          expect.arrayContaining([{ name: pluginName, version, targets: ["npm"] }]),
        );
      }
    }),
  );

  publicationIt.concurrent(
    "projects a selected plugin without claiming core publication or changing focused coverage",
    withCommand(async (processFixture, check) => {
      const result = await fixture(processFixture, check, {
        selection: selectedPlugins(pluginName),
      });
      check(result.status, result.stderr).toBe(0);
      check(result.fact?.projection?.packages).toEqual([
        { name: pluginName, version: stable, targets: ["clawhub", "npm"] },
      ]);
      check(result.steps.plugin_npm_preflight?.outputs).toEqual({
        required: "true",
        publish_scope: "selected",
        plugins: pluginName,
        npm_dist_tag: "default",
      });
      check(result.fact?.projection?.platforms).not.toContainEqual(platform("linux"));
      check(result.fact?.coverage.rerun_group).toBe("ci");
    }),
    30_000,
  );

  publicationIt.concurrent.for([
    { version: stable, pin: stable, core: true, selected: true },
    { version: "2026.9.9-1", pin: stable, core: true, selected: true },
    { version: stable, pin: "2026.8.1", core: true, selected: false },
    { version: stable, pin: "2026.9.09", core: true, selected: false },
    { version: stable, pin: stable, core: false, selected: false },
    { version: beta, pin: stable, core: true, selected: false },
    { version: extended, pin: extended, core: true, selected: false },
  ])(
    "projects Android from committed $version pin=$pin core=$core without qualification",
    { timeout: 30_000 },
    withCase(async ({ version, pin, core, selected }, processFixture, check) => {
      const npmDistTag = version.includes("-beta.")
        ? "beta"
        : version === extended
          ? "extended-stable"
          : "latest";
      const result = await fixture(processFixture, check, {
        version,
        targetContextRef:
          npmDistTag === "extended-stable"
            ? `extended-stable/${version}`
            : `release/${version.replace(/-beta\.[0-9]+$/u, "")}`,
        androidPin: pin,
        fault: "dirty-android-pin",
        selection: {
          ...selection,
          npmDistTag,
          publishOpenclawNpm: core,
          route: npmDistTag === "extended-stable" ? npmDistTag : "normal",
        },
      });
      check(result.status, result.stderr).toBe(0);
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      if (selected) {
        check(platforms).toContainEqual({
          id: "android",
          source: ".github/workflows/android-release.yml",
        });
      } else {
        check(platforms).not.toContainEqual(platform("android"));
      }
      if (npmDistTag !== "extended-stable") {
        for (const id of ["docker", "vcr"]) {
          if (core) {
            check(platforms).toContainEqual(platform(id));
          } else {
            check(platforms).not.toContainEqual(platform(id));
          }
        }
      }
    }),
  );

  publicationIt("keeps every expensive first-hop consumer behind successful resolution", () => {
    for (const id of ["normal_ci", "prepare_npm_package", "prepare_docker_release"]) {
      const job = expectDefined(workflow.jobs[id], `${id} job`);
      expect([job.needs].flat()).toContain("resolve_target");
      for (const result of ["success", "failure"]) {
        expect(
          evaluate(job.if ?? "", {
            github: { run_attempt: 1 },
            inputs: { rerun_group: "all" },
            needs: {
              resolve_target: {
                result,
                outputs: {
                  candidate_required: "true",
                  target_version: stable,
                },
              },
              plugin_compatibility_readiness: { result: "success" },
              evidence_reuse: { result: "skipped", outputs: { reuse: "false" } },
            },
          }),
        ).toBe(result === "success");
      }
    }
  });
});

describe("publication source intent and durable binding", () => {
  publicationIt.concurrent.for([
    "scripts/full-release-publication-contract.mjs",
    "scripts/full-release-publication-admission.mts",
  ])(
    "imports %s from stdin without entering its CLI",
    withCase(async (path, processFixture, check) => {
      const result = await processFixture.run(
        process.execPath,
        ["--import", "./scripts/tsx.mjs", "--input-type=module", "-"],
        {
          cwd: repo,
          input: `await import(${JSON.stringify(pathToFileURL(join(repo, path)).href)}); process.stdout.write("imported\\n");`,
          env: { PATH: process.env.PATH },
          encoding: "utf8",
        },
      );
      if (result.error !== undefined) {
        throw result.error instanceof Error
          ? result.error
          : new Error("Unexpected publication command failure", { cause: result.error });
      }
      check(result.status, result.stderr).toBe(0);
      check(result.stdout).toBe("imported\n");
      check(result.stderr).toBe("");
    }),
  );

  publicationIt.each([
    ["v0.5", false],
    ["v0.5.0-rc.1", true],
  ])("validates Windows source tag %s using its native version contract", (tag, valid) => {
    const normalize = () =>
      normalizePublicationIntent(
        "publish",
        JSON.stringify({ ...windowsSelection, windowsNodeTag: tag }),
      );
    if (valid) {
      expect(normalize().publicationSelection?.windowsNodeTag).toBe(tag);
    } else {
      expect(normalize).toThrow("invalid Windows source tag");
    }
  });

  publicationIt.each([
    ["unknown", ""],
    ["publish", ""],
    ["publish", JSON.stringify({ ...selection, extra: true })],
    ["publish", JSON.stringify({ ...selection, pluginPublishScope: "selected" })],
    ["publish", JSON.stringify({ ...selection, route: "prepared", publishOpenclawNpm: false })],
  ])("rejects contradictory purpose/selection %s %s", (purpose, value) => {
    expect(() => normalizePublicationIntent(purpose, value)).toThrow();
  });

  publicationIt(
    "requires exact workflow capability and rejects missing or relabeled new evidence",
    () => {
      expect(
        publicationSourceContract('env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n'),
      ).toBe("1");
      expect(
        publicationSourceContract('env:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\n'),
      ).toBeUndefined();
      expect(() =>
        publicationSourceContract('env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "2"\n'),
      ).toThrow();
      const diagnosticIntent = {
        trustedWorkflow: null,
        validationPurpose: "diagnostic",
        publicationSelection: null,
      };
      const environment = publicationSourceEnv(
        {
          trusted_workflow_json: JSON.stringify(diagnosticIntent),
          ref: "main",
          release_profile: "full",
          rerun_group: undefined,
        },
        {
          PUBLICATION_TARGET_CONTEXT: undefined,
          PUBLICATION_TOOLING_JSON: JSON.stringify({
            fullRef: "refs/heads/main",
            sha: "a".repeat(40),
          }),
          GITHUB_REF: "refs/heads/main",
          GITHUB_RUN_ID: "123",
        },
      );
      const request = publicationSourceRequest(environment);
      expect(() =>
        publicationSourceRequest({
          ...environment,
          PUBLICATION_INPUTS_JSON: JSON.stringify({
            ...JSON.parse(environment.PUBLICATION_INPUTS_JSON),
            trusted_workflow_json: JSON.stringify({
              ...diagnosticIntent,
              laneInputs: { known_flaky_jobs_json: '["normalCi:test"]' },
            }),
          }),
        }),
      ).toThrow("invalid source-admission lane inputs");
      const source = createPublicationSourceFact(request, null, null);
      expect(bindSource(source)).toEqual(source);
      expect(source.coverage.extension_test_exclude_patterns_json).toBe("[]");
      const historicalRequest = structuredClone(request);
      delete historicalRequest.coverage.extension_test_exclude_patterns_json;
      const historical = createPublicationSourceFact(historicalRequest, null, null);
      const retained = structuredClone(historical);
      retained.coverage.known_flaky_jobs_json = "[]";
      retained.coverage.telegram_waiver = "";
      refreshDigest(retained);
      for (const fact of [historical, retained]) {
        const bytes = publicationSourceJson(fact);
        expect(bindSource(fact)).toBe(fact);
        expect(publicationSourceJson(fact)).toBe(bytes);
      }
      for (const [key, value] of [
        ["known_flaky_jobs_json", '["normalCi:test"]'],
        ["telegram_waiver", "legacy-omission"],
      ] as const) {
        expect(() =>
          bindSource({
            ...retained,
            coverage: { ...retained.coverage, [key]: value },
          }),
        ).toThrow(`${key} must be empty`);
      }
      const withoutLegacyField = structuredClone(retained);
      delete withoutLegacyField.coverage.telegram_waiver;
      expect(() => bindSource(withoutLegacyField)).toThrow("source admission digest mismatch");
      expect(() =>
        bindSource(historical, {
          validationInputs: {
            ...publicationIntentInputs(historical),
            targetContextRef: "main",
            extensionTestExcludePatternsJson:
              '["extensions/codex/src/app-server/run-attempt.test.ts"]',
          },
        }),
      ).toThrow("coverage extensionTestExcludePatternsJson differs");
      expect(() => validatePublicationSourceBinding({}, { sourceAdmissionContract: "1" })).toThrow(
        "contract missing",
      );
      expect(() => validatePublicationSourceBinding({ sourceAdmissionContract: "1" })).toThrow();
      expect(() => validatePublicationSourceBinding({ sourceAdmission: source })).toThrow(
        "workflow contract",
      );
      expect(() => bindSource({ ...source, validationPurpose: "publish" })).toThrow();
      expect(() => bindSource(source, { targetSha: "c".repeat(40) })).toThrow("targetSha mismatch");
      expect(() =>
        validatePublicationSourceBinding(
          {
            sourceAdmissionContract: "1",
            sourceAdmission: source,
          },
          { targetContextRef: releaseRef },
        ),
      ).toThrow("targetContextRef mismatch");
      expect(() =>
        bindSource(source, {
          trustedWorkflow: {
            fullRef: `refs/tags/release-publish/${"a".repeat(12)}-123`,
            sha: "a".repeat(40),
          },
        }),
      ).toThrow("trustedWorkflowFullRef mismatch");
      const validPackage = { name: "openclaw", version: stable, targets: ["npm"] };
      const projection = { version: stable, packages: [validPackage], platforms: [] };
      const admitted = createPublicationSourceFact(
        {
          ...request,
          ...normalizePublicationIntent("publish", JSON.stringify(selection)),
        },
        { packages: [], platforms: [] },
        projection,
      );
      const badPackages = [
        { name: validPackage.name, targets: validPackage.targets },
        { ...validPackage, version: "invalid" },
        { ...validPackage, targets: [] },
        { ...validPackage, targets: ["other"] },
        { ...validPackage, extra: true },
      ];
      const { rerun_group: _rerunGroup, ...withoutRerunGroup } = admitted.coverage;
      const invalidFacts = [
        ...badPackages.map((entry) =>
          Object.assign({}, admitted, {
            projection: Object.assign({}, projection, { packages: [entry] }),
          }),
        ),
        { ...admitted, projection: { ...projection, platforms: [{ id: "docker" }] } },
        { ...admitted, coverage: withoutRerunGroup },
      ];
      for (const changed of invalidFacts) {
        refreshDigest(changed);
        expect(() => bindSource(changed)).toThrow();
      }
      for (const version of ["2026.9.9-alpha.1", beta, extended, "2026.8.33-1"]) {
        const changed = structuredClone(admitted);
        changed.publicationSelection = normalizePublicationIntent(
          "publish",
          JSON.stringify(windowsSelection),
        ).publicationSelection;
        changed.projection!.version = version;
        changed.projection!.platforms = [
          { id: "windows", source: ".github/workflows/windows-node-release.yml" },
        ];
        refreshDigest(changed);
        expect(() => bindSource(changed)).toThrow("Windows assets require a stable publication");
      }
    },
  );
});
