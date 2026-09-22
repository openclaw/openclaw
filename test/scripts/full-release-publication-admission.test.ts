import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  normalizePublicationIntent,
  publicationIntentInputs,
  publicationSourceContract,
  publicationSourceJson,
  publicationSourceRequest,
  createPublicationSourceFact,
  validatePublicationSourceBinding,
  type PublicationSourceFact,
} from "../../scripts/full-release-publication-contract.mjs";
import { resolveReleaseContextIdentity } from "../../scripts/lib/release-context.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const repo = resolve(".");
const nodeExecutable = realpathSync(requireNodeTool("node"));
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
  on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
  jobs: Record<string, { steps: Step[]; if?: string; needs?: string | string[] }>;
};
const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
const toolingPaths = [
  "package.json",
  "pnpm-lock.yaml",
  "scripts/preflight-frozen-target-contracts.mjs",
  "scripts/lib/frozen-target-source.mjs",
  "scripts/lib/docker-e2e-plan.mts",
  "scripts/lib/docker-e2e-scenarios.mts",
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/upgrade-survivor-policy.mjs",
  "scripts/lib/upgrade-survivor-scenarios.json",
  "scripts/lib/frozen-target-compat.sh",
  "scripts/resolve-frozen-codex-live-suite.mjs",
  "scripts/resolve-fs-safe-native-contract.mjs",
  "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/plan-release-workflow-matrix.mjs",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/plugin-prerelease-test-plan.mts",
  "scripts/plan-targeted-docker-lane-groups.mjs",
  "scripts/lib/numeric-options.mjs",
  "scripts/release-plan-producer.mts",
  "scripts/release-plan-producer-core.mts",
  "scripts/release-plan-contract.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/release-validation-intent.mjs",
  "scripts/lib/bounded-response.mjs",
  "scripts/lib/canonical-json.mjs",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/npm-core-release-packages.json",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/plugin-publication-target.mjs",
  "scripts/lib/pnpm-lockfile-documents.mjs",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/release-version.mjs",
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/plugin-package-contract/src/categories.ts",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/full-release-publication-contract.mjs",
  "scripts/full-release-publication-admission.mts",
  "scripts/full-release-candidate-contract.mjs",
  "scripts/full-release-validation-state.mjs",
  "scripts/full-release-validation-policy.mjs",
  "scripts/release-ci-summary.mjs",
  "scripts/lib/plain-gh.mjs",
  "scripts/lib/release-context.mjs",
  "scripts/lib/release-changelog.mjs",
  "scripts/lib/cross-os-release-checks/suite-filter.mjs",
  "scripts/lib/plugin-npm-release.ts",
  "scripts/lib/npm-json-output.mts",
  "packages/normalization-core/src/expect.ts",
  "src/utils/run-with-concurrency.ts",
  "scripts/tsx.mjs",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/lib/local-check-runtime.mts",
  "scripts/full-release-publication-observations.mts",
  "scripts/lib/plugin-clawhub-release.ts",
  "scripts/clawhub-prepared-artifact.mjs",
  "scripts/clawhub-parent-authorization.mjs",
  "scripts/plugin-publication-artifact.mjs",
  "scripts/lib/actions-artifact-archive.mjs",
  "scripts/lib/arg-utils.runtime.mjs",
  "packages/normalization-core/src/number-coercion.ts",
  "packages/normalization-core/src/utf16-slice.ts",
  "packages/ai/src/internal/retry-after.ts",
  "packages/retry/src/index.ts",
  "src/infra/clawhub-retry.ts",
  "src/infra/map-size.ts",
  "src/infra/retry-after.ts",
  "src/infra/retry-attempt-errors.ts",
  "src/infra/retry.ts",
  "src/infra/secure-random.ts",
  "src/logging/secret-redaction-registry.ts",
  "src/shared/global-singleton.ts",
  "src/shared/regexp.ts",
];
const selection = {
  route: "normal",
  npmDistTag: "latest",
  publishOpenclawNpm: true,
  pluginPublishScope: "all-publishable",
  plugins: [],
};
const windowsSelection = {
  ...selection,
  windowsNodeTag: "v0.5.0",
  windowsNodeInstallerDigests: { "installer.exe": `sha256:${"a".repeat(64)}` },
};

describe("publication dispatch transport", () => {
  const identity = { ref: "main", fullRef: "refs/heads/main", sha: "a".repeat(40) };
  const envelope = {
    trustedWorkflow: identity,
    validationPurpose: "publish",
    publicationSelection: selection,
  };
  it.each<{
    name: string;
    value: unknown;
    pass?: boolean;
    identityFailure?: boolean;
    error?: string;
    extra?: Record<string, string>;
  }>([
    { name: "explicit identity", value: envelope, pass: true },
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
    {
      name: "missing identity",
      value: { validationPurpose: "publish", publicationSelection: selection },
      error: "source-admission envelope requires identity, purpose and selection",
    },
    { name: "old flat identity", value: identity, error: "invalid source-admission envelope" },
    {
      name: "extra envelope field",
      value: { ...envelope, extra: true },
      error: "invalid source-admission envelope",
    },
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
    ({ name, value, pass, identityFailure, error, extra }) => {
      const root = temps.make("openclaw-publication-transport-");
      for (const file of [
        "scripts/full-release-publication-contract.mjs",
        "scripts/clawhub-prepared-artifact.mjs",
        "scripts/clawhub-parent-authorization.mjs",
        "scripts/plugin-publication-artifact.mjs",
        "scripts/release-tooling-identity.mjs",
        "scripts/lib/actions-artifact-archive.mjs",
        "scripts/lib/arg-utils.runtime.mjs",
        "scripts/lib/bounded-response.mjs",
        "scripts/lib/record-shared.mjs",
        "scripts/lib/canonical-json.mjs",
        "scripts/lib/npm-core-release-packages.json",
        "scripts/lib/npm-publish-plan.mjs",
        "scripts/lib/release-version.mjs",
      ]) {
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
      const resolveTarget = expectDefined(workflow.jobs.resolve_target, "resolve_target job");
      const decoderIndex = resolveTarget.steps.findIndex(
        (step) => step.id === "publication_dispatch",
      );
      const identityIndex = resolveTarget.steps.findIndex((step) => step.id === "tooling_identity");
      expect(decoderIndex).toBeGreaterThan(0);
      expect(identityIndex).toBe(decoderIndex + 1);
      expect(identityIndex).toBeLessThan(
        resolveTarget.steps.findIndex((step) => step.id === "resolve"),
      );
      let status = 0;
      let stderr = "";
      const completed: string[] = [];
      for (const step of resolveTarget.steps.slice(decoderIndex, identityIndex + 1)) {
        const output = join(root, `${step.id}.out`);
        const env: Record<string, string> = {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_OUTPUT: output,
        };
        const context = {
          inputs,
          steps,
          toJSON: JSON.stringify,
          github: { token: "", ref: identity.fullRef, ref_name: identity.ref, sha: identity.sha },
          env: { RELEASE_ISOLATION_TOOLING_CONTRACT: "2" },
        };
        for (const [key, raw] of Object.entries(step.env ?? {})) {
          env[key] = raw.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match, expression: string) =>
            String(evaluate(expression, context)),
          );
        }
        const result = spawnSync("bash", ["-c", expectDefined(step.run, "transport command")], {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
        status = result.status ?? 1;
        stderr += result.stderr;
        if (status !== 0) {
          break;
        }
        completed.push(step.id!);
        const outputs = Object.fromEntries(
          readFileSync(output, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        steps[step.id!] = { outputs };
      }
      if (pass) {
        expect(status, stderr).toBe(0);
        expect(
          JSON.parse(expectDefined(steps.tooling_identity?.outputs.json, "resolved identity")),
        ).toEqual(identity);
        expect(completed).toEqual(["publication_dispatch", "tooling_identity"]);
        const forwarded = expectDefined(
          steps.publication_dispatch?.outputs.trusted_workflow_json,
          "identity transport",
        );
        expect(forwarded ? JSON.parse(forwarded) : null).toEqual(
          name === "direct identity inference" ? null : identity,
        );
        expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
      } else {
        expect(status, stderr).toBe(1);
        expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
        expect(stderr).toContain(expectDefined(error, "expected rejection reason"));
        expect(completed).toEqual(identityFailure ? ["publication_dispatch"] : []);
        expect(existsSync(calls)).toBe(false);
        expect(steps.tooling_identity).toBeUndefined();
      }
    },
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

function fixture(
  options: {
    version?: string;
    targetContextRef?: string;
    purpose?: string;
    selection?: Record<string, unknown> | null;
    sameSha?: boolean;
    toolingFullRef?: string;
    androidPin?: string;
    legacyPlatforms?: "absent-helper" | "dormant-helper";
    registry?:
      | "healthy"
      | "npm-empty-history"
      | "npm-error"
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
  const root = temps.make("frv-publication-admission-");
  const tooling = join(root, "workflow");
  let target = join(root, "target");
  const temporary = join(root, "tmp");
  for (const directory of [tooling, target, temporary]) {
    mkdirSync(directory);
  }
  const write = (directory: string, path: string, bytes: string | Buffer) => {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  const git = (directory: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "--no-lazy-fetch",
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
  git(target, "init", "-q");
  const version = options.version ?? "2026.9.9";
  write(target, "package.json", JSON.stringify({ name: "openclaw", version, type: "module" }));
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
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
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
      write(
        directory,
        "packages/gateway-client/package.json",
        JSON.stringify({
          name: "@openclaw/gateway-client",
          version,
          openclaw: { release: { publishToNpm: true } },
        }),
      );
    }
  };
  writePlugins(target);
  if (options.fault === "unselected") {
    const other = writePublishablePluginFixture(target, {
      extensionId: "other-plugin",
      version,
      publishTo: "both",
    });
    rmSync(join(other.packageDir, "README.md"));
  }
  if (options.fault === "readme") {
    rmSync(join(target, "extensions/demo-plugin/README.md"));
  }
  if (options.fault === "symlink") {
    rmSync(join(target, "extensions/demo-plugin/README.md"));
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
  git(tooling, "init", "-q", "-b", "main");
  for (const path of toolingPaths) {
    write(tooling, path, readFileSync(join(repo, path)));
  }
  const registryCalls = join(root, "registry-calls.jsonl");
  {
    // This is committed trusted fixture code, not a candidate preload or a
    // production injection flag. Every attempted public read stays in memory.
    write(
      tooling,
      "scripts/tsx.mjs",
      readFileSync(join(tooling, "scripts/tsx.mjs"), "utf8") +
        `
const { appendFileSync } = await import("node:fs");
const { basename } = await import("node:path");
const record = (value) => appendFileSync(${JSON.stringify(registryCalls)}, JSON.stringify(value) + "\\n");
const worker = basename(process.argv[1] ?? "") === "full-release-publication-observations.mts";
const sizeFault = ${JSON.stringify(options.fault)};
if (sizeFault?.startsWith("size-")) {
  const childProcess = (await import("node:child_process")).default;
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (file, args, ...rest) => {
    if (file === "git" && args.includes("pack-objects")) record({ kind: "source-pack" });
    const output = original(file, args, ...rest);
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
      Date.now = () => now() + 300001;
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
  if (${JSON.stringify(options.registry)} === "clawhub-absent") return response("", 404);
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
  write(
    tooling,
    "scripts/lib/release-publish-children.sh",
    readFileSync(join(repo, "scripts/lib/release-publish-children.sh")),
  );
  for (const directory of [".github/workflows", "scripts/e2e/lib/upgrade-survivor/config-recipe"]) {
    cpSync(join(repo, directory), join(tooling, directory), { recursive: true });
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
    const manifest = JSON.parse(readFileSync(join(tooling, "package.json"), "utf8"));
    write(
      tooling,
      "package.json",
      JSON.stringify({ ...manifest, version, dependencies: { yaml: "2.9.0" } }),
    );
    writePlugins(tooling);
    write(tooling, "apps/android/version.json", androidVersion);
  }
  let toolingSha = commit(tooling);
  const toolingFullRef = options.toolingFullRef ?? "refs/heads/main";
  const toolingRef = toolingFullRef.replace(/^refs\/heads\//u, "");
  if (toolingFullRef !== "refs/heads/main") {
    const base = toolingSha;
    write(tooling, "main-only.txt", "main-only\n");
    commit(tooling);
    git(tooling, "checkout", "-qb", toolingRef, base);
    write(tooling, "alpha-only.txt", "alpha-only\n");
    toolingSha = commit(tooling);
    expect(
      spawnSync("git", ["merge-base", "--is-ancestor", toolingSha, "main"], {
        cwd: tooling,
      }).status,
    ).toBe(1);
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
  if (options.fault === "bootstrap") {
    write(
      tooling,
      "scripts/release-plan-producer.mts",
      readFileSync(join(tooling, "scripts/release-plan-producer.mts"), "utf8") +
        "\n// changed bootstrap\n",
    );
  }
  if (options.fault === "import") {
    write(
      tooling,
      "scripts/lib/bounded-response.mjs",
      readFileSync(join(tooling, "scripts/lib/bounded-response.mjs"), "utf8") +
        "\n// changed import\n",
    );
  }
  if (options.fault === "worker-import") {
    write(
      tooling,
      "src/infra/clawhub-retry.ts",
      readFileSync(join(tooling, "src/infra/clawhub-retry.ts"), "utf8") +
        "\n// changed worker import\n",
    );
  }
  if (options.fault === "dirty-candidate") {
    write(target, "extensions/demo-plugin/package.json", "not JSON");
  }
  if (options.fault === "dirty-android-pin") {
    write(target, "apps/android/version.json", JSON.stringify({ version: "2026.8.1" }));
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
    release_profile: "beta",
    run_release_soak: false,
    rerun_group: options.rerunGroup ?? "ci",
    trusted_workflow_json: JSON.stringify({
      trustedWorkflow: { ref: toolingRef, fullRef: toolingFullRef, sha: toolingSha },
      validationPurpose: options.purpose ?? "publish",
      publicationSelection: options.selection === null ? null : (options.selection ?? selection),
    }),
  };
  // These commands start after the existing target-identity owner; retain its
  // real version/context contract without claiming to exercise remote ancestry.
  expect(resolveReleaseContextIdentity(inputs.target_context_ref, version)).not.toBeNull();
  const steps: Record<string, { outputs: Record<string, string>; outcome: string }> = {
    resolve: { outputs: { sha: targetSha }, outcome: "success" },
    release_inputs: {
      outputs: { coverage_policy: "", target_version: version, skip_package_telegram_e2e: "false" },
      outcome: "success",
    },
    tooling_identity: {
      outputs: {
        json: JSON.stringify({ fullRef: toolingFullRef, ref: toolingRef, sha: toolingSha }),
      },
      outcome: "success",
    },
    filters: {
      outputs: {
        repo_live_suite_filter: "",
        qa_filter_seen: "",
        live_suite_filter: "",
        cross_os_suite_filter: "",
      },
      outcome: "success",
    },
    candidate_request: { outputs: { request_sha256: "" }, outcome: "success" },
    ...(options.sameSha || options.registry
      ? { frozen_selection: { outputs: { parser_required: "false" }, outcome: "success" } }
      : {}),
  };
  const context = {
    inputs,
    steps,
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
  const resolveTarget = expectDefined(workflow.jobs.resolve_target, "resolve_target job");
  const start = resolveTarget.steps.findIndex((step) => step.id === "release_inputs") + 1;
  const end = resolveTarget.steps.findIndex((step) => step.name === "Summarize target");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
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
      expect(step.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
      expect(step.with).toEqual({
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
      writeFileSync(
        join(temporary, "upload-artifact.json"),
        JSON.stringify({
          id: 456,
          name: "full-release-publication-observations-123-1",
          digest: `sha256:${digest}`,
          expired: false,
          size_in_bytes: bytes.length + 1024,
          workflow_run: { id: 123, head_sha: toolingSha, head_branch: toolingRef },
        }),
      );
      steps[step.id!] = {
        outcome: options.uploadFault === "failure" ? "failure" : "success",
        outputs: { "artifact-id": "456", "artifact-digest": digest },
      };
      if (options.uploadFault === "wrong-descriptor") {
        const metadataPath = join(temporary, "upload-artifact.json");
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
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
      expect(step["working-directory"]).toBe("workflow");
      expect(step.run.trim()).toBe(
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
      PATH: `${bin}:${process.env.PATH}`,
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
      NODE_OPTIONS: "--no-warnings",
      NODE_PATH: join(root, "untrusted-modules"),
      HTTPS_PROXY: "http://proxy.invalid",
    };
    for (const [name, value] of Object.entries(step.env ?? {})) {
      env[name] = value.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match, expression: string) => {
        const resolved = evaluate(expression, { ...context, toJSON: JSON.stringify });
        if (resolved === undefined || resolved === null) {
          return "";
        }
        if (
          typeof resolved === "string" ||
          typeof resolved === "number" ||
          typeof resolved === "boolean"
        ) {
          return String(resolved);
        }
        throw new Error("workflow environment fixture requires an explicit scalar or toJSON");
      });
    }
    if (
      step.name === "Finalize publication admission" &&
      options.uploadFault === "late-admission"
    ) {
      const observation = JSON.parse(
        readFileSync(join(temporary, "publication-observations.json"), "utf8"),
      );
      const clock = join(temporary, "upload-clock.cjs");
      writeFileSync(
        clock,
        `const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) {
    super(...(args.length ? args : [${Date.parse(observation.prerequisitesCompletedAt) + 300_001}]));
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
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: step["working-directory"] ? join(root, step["working-directory"]) : root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
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
      const outputs = existsSync(output)
        ? Object.fromEntries(
            readFileSync(output, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const split = line.indexOf("=");
                return [line.slice(0, split), line.slice(split + 1)];
              }),
          )
        : {};
      steps[step.id] = { outputs, outcome: "success" };
    }
  }
  if (!options.sameSha) {
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  }
  expect(existsSync(forbidden), stderr).toBe(false);
  if (options.registry === "parent-interrupt") {
    const deadline = Date.now() + 5000;
    while (
      !readFileSync(registryCalls, "utf8")
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          const entry = JSON.parse(line);
          return entry.kind === "settled" && entry.worker;
        }) &&
      Date.now() < deadline
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const factPath = join(temporary, "publication-source-admission.json");
  const fact =
    existsSync(factPath) && readFileSync(factPath, "utf8").trim()
      ? (JSON.parse(readFileSync(factPath, "utf8")) as PublicationSourceFact)
      : undefined;
  const observationPath = join(temporary, "publication-observations.json");
  const observationText = existsSync(observationPath) ? readFileSync(observationPath, "utf8") : "";
  expect(observationText).not.toContain(root);
  expect(observationText).not.toContain("openclaw-publication-source-");
  expect(observationText).not.toContain("publication-parent-env-canary");
  expect(observationText).not.toContain('"packageDir"');
  const registryTrace = existsSync(registryCalls)
    ? readFileSync(registryCalls, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
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
            },
        )
    : [];
  const workerBoundary = registryTrace.find((entry) => entry.kind === "worker-boundary");
  let scratchCleanedByOwner = true;
  if (options.registry === "parent-interrupt" && workerBoundary) {
    expect(registryTrace).toContainEqual(
      expect.objectContaining({ kind: "settled", worker: true, active: 0 }),
    );
    const proc = `/proc/${workerBoundary.pid}/stat`;
    const deadline = Date.now() + 2000;
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
    while (live() && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    expect(live()).toBe(false);
    const snapshot = expectDefined(workerBoundary.snapshot, "owned worker snapshot");
    scratchCleanedByOwner = !existsSync(snapshot);
    if (!scratchCleanedByOwner) {
      const scratch = dirname(snapshot);
      expect(workerBoundary.home).toBe(join(scratch, "worker-home"));
      expect(scratch).toContain("openclaw-publication-source-");
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (workerBoundary) {
    expect(workerBoundary).toMatchObject({
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
      expect(existsSync(expectDefined(path, "worker isolated path"))).toBe(false);
    }
    expect(stderr).not.toContain("publication-parent-env-canary");
    expect(stderr).not.toContain(root);
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
      ? JSON.parse(readFileSync(join(temporary, "publication-admission.json"), "utf8"))
      : undefined,
    scratchCleanedByOwner,
    firstHopJobs: options.registry
      ? ["normal_ci", "prepare_npm_package", "docker_runtime_assets_preflight"].filter((id) => {
          const job = expectDefined(workflow.jobs[id], "first-hop job");
          expect([job.needs].flat()).toContain("resolve_target");
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
              evidence_reuse: { result: "skipped", outputs: { reuse: "false" } },
            },
          });
        })
      : [],
    registryCalls: registryTrace,
    requests: existsSync(requests)
      ? readFileSync(requests, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [],
  };
}

describe("FRV required registry admission", () => {
  it.each([undefined, "failure", "wrong-descriptor", "late-admission"] as const)(
    "binds actual post-upload admission without rewriting uploaded observations: %s",
    (uploadFault) => {
      const result = fixture({ registry: "healthy", uploadFault });
      expect(result.uploadedObservations).toBe(result.observationText);
      expect(result.effects.indexOf("Upload immutable publication observations")).toBeLessThan(
        result.effects.indexOf("Finalize publication admission"),
      );
      if (uploadFault) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/upload|freshness/u);
        expect(result.publicationAdmission).toBeUndefined();
        expect(result.firstHopJobs).toEqual([]);
      } else {
        expect(result.status, result.stderr).toBe(0);
        const admission = result.publicationAdmission.publicationAdmission;
        expect(admission.observations).toEqual(result.observations);
        expect(admission.binding.status).toBe("admitted-for-validation");
        expect(admission.binding.artifact.name).toBe("full-release-publication-observations-123-1");
        expect(Date.parse(admission.binding.admittedAt)).toBeGreaterThanOrEqual(
          Date.parse(result.observations.collectionCompletedAt),
        );
        expect(result.firstHopJobs).toEqual(["normal_ci"]);
      }
    },
  );
  it.each([
    ["healthy", "normal", "2026.9.9", "latest", ["normal_ci", "prepare_npm_package"]],
    ["npm-empty-history", "normal", "2026.9.9", "latest", []],
    ["npm-error", "normal", "2026.9.9", "latest", []],
    ["prepared-trust", "prepared", "2026.9.9", "latest", []],
    ["npm-error", "alpha", "2026.9.9-alpha.1", "alpha", []],
  ] as const)(
    "keeps selected fanout closed for %s through %s",
    (registry, route, version, npmDistTag, expectedJobs) => {
      const result = fixture({
        registry,
        rerunGroup: "all",
        version,
        targetContextRef: version.includes("-alpha.") ? `v${version}` : "release/2026.9.9",
        selection: { ...selection, route, npmDistTag },
      });
      expect(result.targetSha).not.toBe(result.toolingSha);
      expect(result.effects).toContain("Provision trusted admission parser");
      expect(result.effects).toContain("Admit publication source");
      expect(result.registryCalls).toContainEqual({ kind: "runtime", worker: true, inherited: [] });
      const actualRequests = result.registryCalls.filter((entry) => entry.kind === "request");
      expect(actualRequests.length).toBeGreaterThan(0);
      if (registry === "healthy") {
        expect(actualRequests).toEqual(
          expect.arrayContaining([
            { kind: "request", origin: "https://registry.npmjs.org", path: "/openclaw" },
            {
              kind: "request",
              origin: "https://registry.npmjs.org",
              path: "/%40openclaw%2Fdemo-plugin",
            },
            {
              kind: "request",
              origin: "https://clawhub.ai",
              path: "/api/v1/packages/%40openclaw%2Fdemo-plugin",
            },
            {
              kind: "request",
              origin: "https://clawhub.ai",
              path: "/api/v1/packages/%40openclaw%2Fdemo-plugin/trusted-publisher",
            },
            {
              kind: "request",
              origin: "https://clawhub.ai",
              path: `/api/v1/packages/%40openclaw%2Fdemo-plugin/versions/${version}`,
            },
          ]),
        );
        expect(actualRequests).toHaveLength(5);
        expect(result.observations).toMatchObject({
          sourceDigest: result.fact?.digest,
          pendingAuthority: [],
        });
      }
      expect(result.firstHopJobs, result.stderr).toEqual(expectedJobs);
      expect(result.status, result.stderr).toBe(registry === "healthy" ? 0 : 1);
    },
    30_000,
  );
});

describe("FRV observation worker boundary", () => {
  it.each([
    [
      "beta plugin",
      "2026.9.9-beta.1",
      "2026.9.9-beta.1",
      "normal",
      "beta",
      "@openclaw/demo-plugin",
      "npm-absent",
      true,
    ],
    ["root package", "2026.9.9", "2026.9.9", "normal", "latest", "openclaw", "npm-absent", false],
    [
      "core package",
      "2026.9.9",
      "2026.9.9",
      "normal",
      "latest",
      "@openclaw/gateway-client",
      "npm-absent",
      false,
    ],
    [
      "stable plugin on beta",
      "2026.9.9",
      "2026.9.9",
      "normal",
      "beta",
      "@openclaw/demo-plugin",
      "npm-absent",
      false,
    ],
    [
      "stable plugin on latest",
      "2026.9.9",
      "2026.9.9",
      "normal",
      "latest",
      "@openclaw/demo-plugin",
      "npm-absent",
      true,
    ],
    [
      "beta plugin with stable parent",
      "2026.9.9",
      "2026.9.9-beta.1",
      "normal",
      "latest",
      "@openclaw/demo-plugin",
      "npm-absent",
      true,
    ],
    [
      "stable plugin with beta parent",
      "2026.9.9-beta.1",
      "2026.9.9",
      "normal",
      "beta",
      "@openclaw/demo-plugin",
      "npm-absent",
      false,
    ],
    [
      "prepared stable plugin",
      "2026.9.9",
      "2026.9.9",
      "prepared",
      "latest",
      "@openclaw/demo-plugin",
      "npm-absent",
      true,
    ],
    [
      "prepared beta plugin",
      "2026.9.9-beta.1",
      "2026.9.9-beta.1",
      "prepared",
      "beta",
      "@openclaw/demo-plugin",
      "npm-absent",
      true,
    ],
    [
      "prepared npm-only beta plugin",
      "2026.9.9-beta.1",
      "2026.9.9-beta.1",
      "prepared",
      "beta",
      "@openclaw/demo-plugin",
      "npm-absent",
      true,
    ],
    [
      "alpha plugin",
      "2026.9.9-alpha.1",
      "2026.9.9-alpha.1",
      "alpha",
      "alpha",
      "@openclaw/demo-plugin",
      "npm-absent",
      false,
    ],
    [
      "extended plugin",
      "2026.8.33",
      "2026.8.33",
      "extended-stable",
      "extended-stable",
      "@openclaw/demo-plugin",
      "npm-absent",
      false,
    ],
    [
      "beta empty history",
      "2026.9.9-beta.1",
      "2026.9.9-beta.1",
      "normal",
      "beta",
      "@openclaw/demo-plugin",
      "npm-empty-history",
      false,
    ],
    [
      "stable empty history",
      "2026.9.9",
      "2026.9.9",
      "normal",
      "latest",
      "@openclaw/demo-plugin",
      "npm-empty-history",
      false,
    ],
  ] as const)(
    "matches npm bootstrap writer ownership for %s",
    (_label, version, pluginVersion, route, npmDistTag, absentNpmPackage, registry, admitted) => {
      const result = fixture({
        version,
        pluginVersion,
        npmOnlyPlugin: _label === "prepared npm-only beta plugin",
        registry,
        absentNpmPackage,
        includeCorePackage: absentNpmPackage === "@openclaw/gateway-client",
        targetContextRef:
          route === "extended-stable"
            ? `extended-stable/${version}`
            : route === "alpha"
              ? `v${version}`
              : "release/2026.9.9",
        rerunGroup: "all",
        selection: { ...selection, route, npmDistTag },
      });
      expect(result.effects).toContain("Admit publication source");
      expect(result.registryCalls).toContainEqual({
        kind: "request",
        origin: "https://registry.npmjs.org",
        path: `/${encodeURIComponent(absentNpmPackage)}`,
      });
      expect(result.firstHopJobs, result.stderr).toEqual(
        admitted ? ["normal_ci", "prepare_npm_package"] : [],
      );
      expect(result.status, result.stderr).toBe(admitted ? 0 : 1);
      if (admitted) {
        expect(result.observations.pendingAuthority).toEqual([
          {
            registry: "npm",
            name: absentNpmPackage,
            action: "owner-preparation-and-access",
            status: "unresolved",
          },
        ]);
        expect(result.observations.npm).toContainEqual(
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
        expect(result.observations).not.toHaveProperty("admittedAt");
      } else {
        expect(result.observations).toBeUndefined();
        expect(result.stderr).toContain(
          registry === "npm-empty-history" ? "http-200" : "unsupported-bootstrap",
        );
      }
    },
    30_000,
  );

  it("keeps required observations when only advisories exhaust the aggregate byte budget", () => {
    const result = fixture({ registry: "advisory-budget", advisoryCount: 20 });
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.observations.npm.filter((entry: { required: boolean }) => entry.required),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "openclaw", outcome: "observed" }),
        expect.objectContaining({ name: "@openclaw/demo-plugin", outcome: "observed" }),
      ]),
    );
    expect(result.observations.npm).toHaveLength(22);
    expect(result.observations.plans.npm.warnings.length).toBeGreaterThan(0);
    const abortAt = result.registryCalls.findIndex((entry) => entry.kind === "advisory-abort");
    expect(abortAt).toBeGreaterThan(0);
    expect(
      result.registryCalls.slice(abortAt + 1).filter((entry) => entry.kind === "request"),
    ).toEqual([]);
    expect(
      result.registryCalls.filter((entry) => entry.path?.startsWith("/advisory-")).length,
    ).toBeLessThan(20);
    expect(result.registryCalls).toContainEqual(
      expect.objectContaining({ kind: "settled", worker: true, active: 0 }),
    );
  }, 30_000);

  it.runIf(process.platform === "linux").each(["SIGINT", "SIGTERM"] as const)(
    "forwards parent-only termination %s and joins the worker before snapshot cleanup",
    (parentSignal) => {
      const result = fixture({ registry: "parent-interrupt", parentSignal });
      expect(result.registryCalls).not.toContainEqual({ kind: "fixture-termination" });
      expect(result.registryCalls).toContainEqual({ kind: "worker-termination" });
      expect(result.scratchCleanedByOwner).toBe(true);
      expect(result.status, result.stderr).toBe(1);
      expect(result.observations).toBeUndefined();
    },
    30_000,
  );

  it.each(["required-budget", "advisory-deadline"] as const)(
    "keeps %s fatal rather than downgrading it to a latest warning",
    (registry) => {
      const result = fixture({
        registry,
        ...(registry === "required-budget" ? { pluginCount: 20 } : { latestDependency: true }),
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        registry === "required-budget" ? "response-too-large" : "cancelled-or-timeout",
      );
      expect(result.observations).toBeUndefined();
      expect(result.firstHopJobs).toEqual([]);
      expect(result.registryCalls).toContainEqual(
        expect.objectContaining({ kind: "settled", worker: true, active: 0 }),
      );
    },
    30_000,
  );

  it.each([
    ["npm-absent", "normal", true, "npm", "owner-preparation-and-access"],
    ["npm-absent", "prepared", true, "npm", "owner-preparation-and-access"],
    ["clawhub-absent", "normal", true, "clawhub", "bootstrap-and-owner-access"],
    ["clawhub-absent", "prepared", false, "clawhub", ""],
    ["missing-trust", "normal", true, "clawhub", "publisher-repair"],
    ["missing-trust", "prepared", false, "clawhub", ""],
  ] as const)(
    "distinguishes %s on %s without claiming downstream authority",
    (registry, route, admitted, registryName, action) => {
      const result = fixture({ registry, selection: { ...selection, route } });
      expect(result.status, result.stderr).toBe(admitted ? 0 : 1);
      expect(result.registryCalls).toContainEqual({ kind: "runtime", worker: true, inherited: [] });
      if (admitted) {
        expect(result.observations.pendingAuthority).toContainEqual({
          registry: registryName,
          name: "@openclaw/demo-plugin",
          action,
          status: "unresolved",
        });
        expect(result.observations).not.toHaveProperty("admittedAt");
      } else {
        expect(result.observations).toBeUndefined();
        expect(result.firstHopJobs).toEqual([]);
      }
    },
    30_000,
  );

  it.each(["concurrency", "advisory-error"] as const)(
    "shares required/advisory reads across both planners with %s",
    (registry) => {
      const count = registry === "concurrency" ? 10 : 1;
      const result = fixture({ registry, pluginCount: count, latestDependency: true });
      expect(result.status, result.stderr).toBe(0);
      const reads = result.registryCalls.filter((entry) => entry.kind === "request");
      expect(reads).toHaveLength(4 * count + 2);
      expect(reads.filter((entry) => entry.path === "/demo-runtime")).toHaveLength(1);
      const settlement = result.registryCalls.find(
        (entry) => entry.kind === "settled" && entry.worker,
      );
      expect(settlement).toMatchObject({ active: 0 });
      expect(settlement?.maximumActive).toBeLessThanOrEqual(8);
      if (registry === "concurrency") {
        expect(settlement?.maximumActive).toBe(8);
      }
      expect(result.observations.plans.npm.all).toHaveLength(count);
      expect(result.observations.plans.clawhub.all).toHaveLength(count);
      expect(result.observations.plans.npm.warnings).toHaveLength(count);
      expect(result.observations.plans.clawhub.warnings).toHaveLength(count);
      if (registry === "advisory-error") {
        expect(result.observations.npm).toContainEqual(
          expect.objectContaining({
            name: "demo-runtime",
            required: false,
            outcome: "unavailable",
            error: "http-403",
          }),
        );
      }
    },
    30_000,
  );

  it("aborts and drains a pending peer body after a required failure", () => {
    const result = fixture({ registry: "abort-peer" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("required npm observation http-403");
    expect(result.registryCalls).toContainEqual({ kind: "body-cancelled" });
    expect(result.registryCalls).toContainEqual(
      expect.objectContaining({
        kind: "settled",
        active: 0,
        worker: true,
      }),
    );
    expect(result.firstHopJobs).toEqual([]);
    expect(result.observations).toBeUndefined();
  }, 30_000);

  it("keeps advisory warning volume from blocking validation", () => {
    const result = fixture({ registry: "advisory-error", pluginCount: 80, latestDependency: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.observations.plans.npm.warnings).toHaveLength(80);
    expect(result.observations.plans.clawhub.warnings).toHaveLength(80);
    expect(result.registryCalls.filter((entry) => entry.path === "/demo-runtime")).toHaveLength(1);
  }, 30_000);

  it.each(["worker-object", "worker-import", "candidate-object", "yaml"] as const)(
    "rejects %s before any public read",
    (fault) => {
      const result = fixture({ registry: "healthy", fault });
      expect(result.status, result.stderr).toBe(1);
      expect(result.registryCalls.filter((entry) => entry.kind === "request")).toEqual([]);
      expect(result.firstHopJobs).toEqual([]);
      expect(result.observations).toBeUndefined();
    },
    30_000,
  );

  it("uses the existing parser-false runtime for a same-SHA worker", () => {
    const result = fixture({ registry: "healthy", sameSha: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.targetSha).toBe(result.toolingSha);
    expect(result.registryCalls.filter((entry) => entry.kind === "request")).toHaveLength(5);
    expect(result.registryCalls).toContainEqual({ kind: "runtime", worker: true, inherited: [] });
  }, 30_000);
});

describe("FRV publication source admission", () => {
  it.each([
    ["size-missing", "invalid publication source object-size response"],
    ["size-wrong-oid", "invalid publication source object-size response"],
    ["size-unterminated", "invalid publication source object-size response"],
    ["size-extra", "invalid publication source object-size response"],
    ["size-individual-limit", "metadata exceeds byte limit"],
    ["size-total-limit", "metadata exceeds byte limit"],
    ["size-limit-before-truncated", "metadata exceeds byte limit"],
  ] as const)(
    "rejects %s before packing or registry reads",
    (fault, error) => {
      const result = fixture({ fault, registry: "healthy" });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(error);
      expect(result.fact).toBeUndefined();
      expect(
        result.registryCalls.filter((entry) => entry.kind === "object-size-batch"),
      ).toHaveLength(1);
      expect(result.registryCalls.filter((entry) => entry.kind === "source-pack")).toEqual([]);
      expect(result.registryCalls.filter((entry) => entry.kind === "request")).toEqual([]);
      expect(result.firstHopJobs).toEqual([]);
    },
    30_000,
  );
  it.each([
    ["2026.9.9", "normal", false],
    ["2026.9.9-1", "normal", false],
    ["2026.9.9", "prepared", false],
    ["2026.9.9-1", "prepared", false],
    ["2026.9.9", "normal", true],
    ["2026.9.9-1", "prepared", true],
  ] as const)(
    "preserves beta-first %s publication through %s with Windows=%s",
    (version, route, windows) => {
      const result = fixture({
        version,
        targetContextRef: `v${version}`,
        selection: { ...(windows ? windowsSelection : selection), route, npmDistTag: "beta" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact).toMatchObject({
        status: "source-admitted",
        publicationSelection: { route, npmDistTag: "beta" },
        projection: { version },
      });
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      expect(platforms).toContainEqual({
        id: "linux",
        source: ".github/workflows/linux-app-release-request.yml",
      });
      if (windows) {
        expect(platforms).toContainEqual(expect.objectContaining({ id: "windows" }));
      } else {
        expect(platforms).not.toContainEqual(expect.objectContaining({ id: "windows" }));
      }
    },
    30_000,
  );

  it.each([
    ["refs/heads/release/2026.9.9", "2026.9.9", "normal", "beta", "release/2026.9.9"],
    [
      "refs/heads/extended-stable/2026.8.33",
      "2026.8.33",
      "extended-stable",
      "extended-stable",
      "extended-stable/2026.8.33",
    ],
  ])(
    "admits canonical branch inventory through actual divergent %s tooling",
    (toolingFullRef, version, route, npmDistTag, targetContextRef) => {
      const result = fixture({
        toolingFullRef,
        version,
        targetContextRef,
        selection: { ...selection, route, npmDistTag },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.targetSha).not.toBe(result.toolingSha);
      expect(result.fact).toMatchObject({
        status: "source-admitted",
        tooling: { ref: toolingFullRef, sha: result.toolingSha },
        projection: { version },
      });
      expect(result.requests).toEqual([
        [
          "api",
          `repos/openclaw/openclaw/git/ref/${toolingFullRef.slice("refs/".length)}`,
          "--method",
          "GET",
        ],
        ["api", "repos/openclaw/openclaw/actions/artifacts/456"],
      ]);
    },
    30_000,
  );

  it("admits alpha inventory through actual divergent Tideclaw tooling", () => {
    const toolingFullRef = "refs/heads/tideclaw/alpha/2026-09-13-1200Z";
    const result = fixture({
      toolingFullRef,
      version: "2026.9.9-alpha.1",
      targetContextRef: "v2026.9.9-alpha.1",
      selection: { ...selection, route: "alpha", npmDistTag: "alpha" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.targetSha).not.toBe(result.toolingSha);
    expect(result.fact).toMatchObject({
      status: "source-admitted",
      candidateSha: result.targetSha,
      tooling: { ref: toolingFullRef, sha: result.toolingSha },
      projection: { version: "2026.9.9-alpha.1" },
    });
    const publisher = parse(
      readFileSync(join(repo, ".github/workflows/openclaw-release-publish.yml"), "utf8"),
    ) as Workflow;
    expect(
      evaluate(expectDefined(publisher.jobs.publish_docker?.if, "Docker predicate"), {
        inputs: {
          tag: "v2026.9.9-alpha.1",
          publish_openclaw_npm: true,
          publish_docker_only: false,
        },
        needs: { publish: { result: "success" }, verify_core_npm_registry: { result: "success" } },
      }),
    ).toBe(false);
    expect(
      evaluate(expectDefined(publisher.jobs.publish_vcr?.if, "VCR predicate"), {
        needs: { publish_docker: { result: "skipped" } },
      }),
    ).toBe(false);
    expect(result.fact?.projection?.platforms).toEqual([]);
    expect(result.requests).toEqual([
      [
        "api",
        "repos/openclaw/openclaw/git/ref/heads/tideclaw/alpha/2026-09-13-1200Z",
        "--method",
        "GET",
      ],
      ["api", "repos/openclaw/openclaw/actions/artifacts/456"],
    ]);
  }, 30_000);

  it("rejects a committed publisher metadata defect before successful root resolution", () => {
    const result = fixture({ fault: "readme" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("README.md must exist");
    for (const id of [
      "normal_ci",
      "prepare_npm_package",
      "prepare_docker_release",
      "docker_runtime_assets_preflight",
    ]) {
      const job = expectDefined(workflow.jobs[id], `${id} job`);
      expect([job.needs].flat()).toContain("resolve_target");
      expect(
        evaluate(job.if ?? "", {
          github: { run_attempt: 1 },
          inputs: { rerun_group: "all" },
          needs: {
            resolve_target: {
              result: result.status === 0 ? "success" : "failure",
              outputs: {
                candidate_required: "true",
                target_version:
                  id === "docker_runtime_assets_preflight" ? "2026.9.9-alpha.1" : "2026.9.9",
              },
            },
            evidence_reuse: { result: "skipped", outputs: { reuse: "false" } },
          },
        }),
      ).toBe(false);
    }
  }, 30_000);

  it.each([false, true])(
    "admits complete committed inventory with same SHA=%s",
    (sameSha) => {
      const result = fixture({ sameSha, fault: sameSha ? undefined : "dirty-candidate" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact).toMatchObject({
        status: "source-admitted",
        candidateSha: result.targetSha,
        tooling: { sha: result.toolingSha },
        coverage: { rerun_group: "ci", release_profile: "beta", run_release_soak: "false" },
      });
      expect(result.fact?.projection?.packages).toEqual(
        expect.arrayContaining([
          { name: "openclaw", version: "2026.9.9", targets: ["npm"] },
          { name: "@openclaw/demo-plugin", version: "2026.9.9", targets: ["clawhub", "npm"] },
        ]),
      );
      expect(result.fact?.projection?.platforms).toEqual(
        expect.arrayContaining([
          { id: "docker", source: ".github/workflows/docker-release.yml" },
          { id: "linux", source: ".github/workflows/linux-app-release-request.yml" },
          { id: "vcr", source: ".github/workflows/vercel-container-registry-publish.yml" },
        ]),
      );
      expect(result.effects).toContain("Provision trusted admission parser");
    },
    30_000,
  );

  it.each(["diagnostic", "main-qualification", "postpublish-confidence"])(
    "retains %s without publication bootstrap or added installation",
    (purpose) => {
      const result = fixture({ purpose, selection: null, fault: "readme" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact).toMatchObject({
        status: "not-applicable",
        validationPurpose: purpose,
        inventoryDigest: null,
        projection: null,
      });
      expect(result.effects).not.toContain("Provision trusted admission parser");
      expect(result.effects).not.toContain("Acquire publication source metadata");
      expect(result.publicationAdmission).toMatchObject({
        publicationAdmissionContract: "1",
        publicationAdmission: null,
      });
      expect(result.observations).toBeUndefined();
      expect(result.registryCalls).toEqual([]);
    },
    30_000,
  );

  it.each([
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
    (fault) => {
      const result = fixture({ fault });
      expect(result.status, result.stderr).toBe(1);
      expect(result.fact).toBeUndefined();
      expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
    },
    30_000,
  );

  it.each([
    ["2026.9.9-alpha.1", "alpha", "alpha", "v2026.9.9-alpha.1", false],
    ["2026.9.9-beta.1", "normal", "beta", "release/2026.9.9", false],
    ["2026.9.9", "normal", "latest", "release/2026.9.9", true],
    ["2026.9.9", "normal", "beta", "v2026.9.9", true],
    ["2026.9.9-1", "normal", "beta", "v2026.9.9-1", true],
  ] as const)(
    "matches actual Windows publication selection for %s through %s to %s",
    (version, route, npmDistTag, targetContextRef, expected) => {
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
      expect(enabled).toBe(expected);
      const result = fixture({
        version,
        targetContextRef,
        selection: { ...windowsSelection, route, npmDistTag },
      });
      if (!enabled) {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Windows assets require a stable publication");
        if (route === "alpha") {
          expect(result.effects).not.toContain("Provision trusted admission parser");
        } else {
          expect(result.effects).toContain("Admit publication source");
        }
        expect(result.fact).toBeUndefined();
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact?.projection?.platforms).toContainEqual({
        id: "windows",
        source: ".github/workflows/windows-node-release.yml",
      });
    },
    30_000,
  );

  it("verifies the full inventory before projecting selected plugins", () => {
    const result = fixture({
      fault: "unselected",
      selection: {
        ...selection,
        publishOpenclawNpm: false,
        pluginPublishScope: "selected",
        plugins: ["@openclaw/demo-plugin"],
      },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("README.md must exist");
  }, 30_000);

  it.each(["absent-helper", "dormant-helper"] as const)(
    "preserves inline platform tooling with %s",
    (legacyPlatforms) => {
      const result = fixture({ legacyPlatforms, selection: windowsSelection });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact?.projection?.platforms).toEqual([
        { id: "android", source: ".github/workflows/android-release.yml" },
        { id: "docker", source: ".github/workflows/docker-release.yml" },
        { id: "vcr", source: ".github/workflows/vercel-container-registry-publish.yml" },
        { id: "windows", source: ".github/workflows/windows-node-release.yml" },
      ]);
    },
    30_000,
  );

  it("rejects unknown selected packages rather than turning them into an empty publication", () => {
    const result = fixture({
      selection: {
        ...selection,
        publishOpenclawNpm: false,
        pluginPublishScope: "selected",
        plugins: ["@openclaw/unknown"],
      },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/unknown|not found|not publishable/iu);
  }, 30_000);

  it.each(["normal", "alpha"])(
    "rejects %s core plus selected plugins before provisioning",
    (route) => {
      const result = fixture({
        selection: {
          ...selection,
          route,
          npmDistTag: route === "alpha" ? "alpha" : "latest",
          pluginPublishScope: "selected",
          plugins: ["@openclaw/demo-plugin"],
        },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("core publication requires all-publishable plugins");
      expect(result.effects).not.toContain("Provision trusted admission parser");
      expect(result.fact).toBeUndefined();
    },
    30_000,
  );

  it.each([
    ["2026.9.9-beta.1", "normal", "beta", "release/2026.9.9"],
    ["2026.9.9", "prepared", "latest", "release/2026.9.9"],
    ["2026.9.9-alpha.1", "alpha", "alpha", "v2026.9.9-alpha.1"],
    ["2026.8.33", "extended-stable", "extended-stable", "extended-stable/2026.8.33"],
  ])(
    "admits %s through the existing %s source policy",
    (version, route, npmDistTag, targetContextRef) => {
      const result = fixture({
        version,
        targetContextRef,
        selection: { ...selection, route, npmDistTag },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact?.projection?.version).toBe(version);
      expect(result.fact?.targetContextRef).toBe(targetContextRef);
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      if (version === "2026.9.9") {
        expect(platforms).toContainEqual({
          id: "linux",
          source: ".github/workflows/linux-app-release-request.yml",
        });
      } else {
        expect(platforms).not.toContainEqual(expect.objectContaining({ id: "linux" }));
      }
      if (route === "extended-stable") {
        expect(result.fact?.projection?.packages).toEqual(
          expect.arrayContaining([{ name: "@openclaw/demo-plugin", version, targets: ["npm"] }]),
        );
      }
    },
    30_000,
  );

  it.each([
    ["2026.9.9-beta.1", "latest", "release/2026.9.9"],
    ["2026.9.9-alpha.1", "beta", "v2026.9.9-alpha.1"],
    ["2026.8.33", "beta", "extended-stable/2026.8.33"],
  ])(
    "rejects incompatible committed %s publication to %s",
    (version, npmDistTag, targetContextRef) => {
      const result = fixture({
        version,
        targetContextRef,
        selection: { ...selection, npmDistTag },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("publication selection does not match");
      expect(result.fact).toBeUndefined();
    },
    30_000,
  );

  it("projects a selected plugin without claiming core publication or changing focused coverage", () => {
    const result = fixture({
      selection: {
        ...selection,
        publishOpenclawNpm: false,
        pluginPublishScope: "selected",
        plugins: ["@openclaw/demo-plugin"],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.fact?.projection?.packages).toEqual([
      { name: "@openclaw/demo-plugin", version: "2026.9.9", targets: ["clawhub", "npm"] },
    ]);
    expect(result.fact?.projection?.platforms).not.toContainEqual(
      expect.objectContaining({ id: "linux" }),
    );
    expect(result.fact?.coverage.rerun_group).toBe("ci");
  }, 30_000);

  it.each([
    { version: "2026.9.9", pin: "2026.9.9", core: true, selected: true },
    { version: "2026.9.9-1", pin: "2026.9.9", core: true, selected: true },
    { version: "2026.9.9", pin: "2026.8.1", core: true, selected: false },
    { version: "2026.9.9", pin: "2026.9.09", core: true, selected: false },
    { version: "2026.9.9", pin: "2026.9.9", core: false, selected: false },
    { version: "2026.9.9-alpha.1", pin: "2026.9.9", core: true, selected: false },
    { version: "2026.9.9-beta.1", pin: "2026.9.9", core: true, selected: false },
    { version: "2026.8.33", pin: "2026.8.33", core: true, selected: false },
  ])(
    "projects Android from committed $version pin=$pin core=$core without qualification",
    ({ version, pin, core, selected }) => {
      const npmDistTag = version.includes("-alpha.")
        ? "alpha"
        : version.includes("-beta.")
          ? "beta"
          : version === "2026.8.33"
            ? "extended-stable"
            : "latest";
      const result = fixture({
        version,
        targetContextRef:
          npmDistTag === "alpha"
            ? `v${version}`
            : npmDistTag === "extended-stable"
              ? `extended-stable/${version}`
              : `release/${version.replace(/-beta\.[0-9]+$/u, "")}`,
        androidPin: pin,
        fault: "dirty-android-pin",
        selection: {
          ...selection,
          npmDistTag,
          publishOpenclawNpm: core,
          route: ["alpha", "extended-stable"].includes(npmDistTag) ? npmDistTag : "normal",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      if (selected) {
        expect(platforms).toContainEqual({
          id: "android",
          source: ".github/workflows/android-release.yml",
        });
      } else {
        expect(platforms).not.toContainEqual(expect.objectContaining({ id: "android" }));
      }
      if (npmDistTag !== "extended-stable") {
        for (const id of ["docker", "vcr"]) {
          if (core && npmDistTag !== "alpha") {
            expect(platforms).toContainEqual(expect.objectContaining({ id }));
          } else {
            expect(platforms).not.toContainEqual(expect.objectContaining({ id }));
          }
        }
      }
    },
    30_000,
  );

  it.each(["v2026.9.9", "2026.9.9\nextra=value"])(
    "rejects an invalid committed Android pin %j before admitting its source",
    (androidPin) => {
      const result = fixture({ androidPin });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("must pin an exact YYYY.M.PATCH Android version");
      expect(result.fact).toBeUndefined();
    },
    30_000,
  );

  it("keeps every expensive first-hop consumer behind successful resolution", () => {
    for (const id of [
      "normal_ci",
      "prepare_npm_package",
      "prepare_docker_release",
      "docker_runtime_assets_preflight",
    ]) {
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
                  target_version:
                    id === "docker_runtime_assets_preflight" ? "2026.9.9-alpha.1" : "2026.9.9",
                },
              },
              evidence_reuse: { result: "skipped", outputs: { reuse: "false" } },
            },
          }),
        ).toBe(result === "success");
      }
    }
  });
});

describe("publication source intent and durable binding", () => {
  it.each([
    "scripts/full-release-publication-contract.mjs",
    "scripts/full-release-publication-admission.mts",
  ])("imports %s from stdin without entering its CLI", (path) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "--input-type=module", "-"],
      {
        cwd: repo,
        input: `await import(${JSON.stringify(pathToFileURL(join(repo, path)).href)}); process.stdout.write("imported\\n");`,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("imported\n");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["vbad", false],
    ["latest", false],
    ["v0.5", false],
    ["v0.5.0", true],
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

  it.each([
    ["", ""],
    ["unknown", ""],
    ["publish", ""],
    ["diagnostic", JSON.stringify(selection)],
    ["publish", JSON.stringify({ ...selection, extra: true })],
    ["publish", JSON.stringify({ ...selection, pluginPublishScope: "selected" })],
    ["publish", JSON.stringify({ ...selection, route: "prepared", publishOpenclawNpm: false })],
  ])("rejects contradictory purpose/selection %s %s", (purpose, value) => {
    expect(() => normalizePublicationIntent(purpose, value)).toThrow();
  });

  it("keeps canonical reusable intent free of per-parent identities", () => {
    expect(
      publicationIntentInputs(normalizePublicationIntent("publish", JSON.stringify(selection))),
    ).toEqual({
      validationPurpose: "publish",
      publicationSelectionJson: publicationSourceJson(selection),
    });
  });

  it("requires exact workflow capability and rejects missing or relabeled new evidence", () => {
    expect(publicationSourceContract('env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n')).toBe(
      "1",
    );
    expect(
      publicationSourceContract('env:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\n'),
    ).toBeUndefined();
    expect(() =>
      publicationSourceContract('env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "2"\n'),
    ).toThrow();
    const request = publicationSourceRequest({
      PUBLICATION_INPUTS_JSON: JSON.stringify({
        trusted_workflow_json: JSON.stringify({
          trustedWorkflow: null,
          validationPurpose: "diagnostic",
          publicationSelection: null,
        }),
        ref: "main",
        release_profile: "full",
      }),
      PUBLICATION_TOOLING_JSON: JSON.stringify({ fullRef: "refs/heads/main", sha: "a".repeat(40) }),
      PUBLICATION_TARGET_SHA: "b".repeat(40),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
    });
    const source = createPublicationSourceFact(request, null, null);
    expect(
      validatePublicationSourceBinding({ sourceAdmissionContract: "1", sourceAdmission: source }),
    ).toEqual(source);
    expect(() => validatePublicationSourceBinding({}, { sourceAdmissionContract: "1" })).toThrow(
      "contract missing",
    );
    expect(() => validatePublicationSourceBinding({ sourceAdmissionContract: "1" })).toThrow();
    expect(() => validatePublicationSourceBinding({ sourceAdmission: source })).toThrow(
      "workflow contract",
    );
    expect(() =>
      validatePublicationSourceBinding({
        sourceAdmissionContract: "1",
        sourceAdmission: { ...source, validationPurpose: "publish" },
      }),
    ).toThrow();
    expect(() =>
      validatePublicationSourceBinding({
        sourceAdmissionContract: "1",
        sourceAdmission: source,
        targetSha: "c".repeat(40),
      }),
    ).toThrow("targetSha mismatch");
    expect(() =>
      validatePublicationSourceBinding(
        {
          sourceAdmissionContract: "1",
          sourceAdmission: source,
        },
        { targetContextRef: "release/2026.9.9" },
      ),
    ).toThrow("targetContextRef mismatch");
    expect(() =>
      validatePublicationSourceBinding({
        sourceAdmissionContract: "1",
        sourceAdmission: source,
        trustedWorkflow: {
          fullRef: `refs/tags/release-publish/${"a".repeat(12)}-123`,
          sha: "a".repeat(40),
        },
      }),
    ).toThrow("trustedWorkflowFullRef mismatch");
    const admitted = createPublicationSourceFact(
      {
        ...request,
        ...normalizePublicationIntent("publish", JSON.stringify(selection)),
      },
      { packages: [], platforms: [] },
      {
        version: "2026.9.9",
        packages: [{ name: "openclaw", version: "2026.9.9", targets: ["npm"] }],
        platforms: [],
      },
    );
    const mutations = [
      (value: Record<string, any>) => {
        delete value.projection.packages[0].version;
      },
      (value: Record<string, any>) => {
        value.projection.packages[0].version = "invalid";
      },
      (value: Record<string, any>) => {
        value.projection.packages[0].targets = [];
      },
      (value: Record<string, any>) => {
        value.projection.packages[0].targets = ["other"];
      },
      (value: Record<string, any>) => {
        value.projection.packages[0].extra = true;
      },
      (value: Record<string, any>) => {
        value.projection.platforms = [{ id: "docker" }];
      },
      (value: Record<string, any>) => {
        delete value.coverage.rerun_group;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(admitted);
      mutate(changed);
      const { digest: _digest, ...content } = changed;
      changed.digest = createHash("sha256").update(publicationSourceJson(content)).digest("hex");
      expect(() =>
        validatePublicationSourceBinding({
          sourceAdmissionContract: "1",
          sourceAdmission: changed,
        }),
      ).toThrow();
    }
    for (const version of ["2026.9.9-alpha.1", "2026.9.9-beta.1", "2026.8.33", "2026.8.33-1"]) {
      const changed = structuredClone(admitted);
      changed.publicationSelection = normalizePublicationIntent(
        "publish",
        JSON.stringify(windowsSelection),
      ).publicationSelection;
      changed.projection!.version = version;
      changed.projection!.platforms = [
        { id: "windows", source: ".github/workflows/windows-node-release.yml" },
      ];
      const { digest: _digest, ...content } = changed;
      changed.digest = createHash("sha256").update(publicationSourceJson(content)).digest("hex");
      expect(() =>
        validatePublicationSourceBinding({
          sourceAdmissionContract: "1",
          sourceAdmission: changed,
        }),
      ).toThrow("Windows assets require a stable publication");
    }
  });
});
