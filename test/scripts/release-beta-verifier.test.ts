import { spawnSync } from "node:child_process";
// Release Beta Verifier tests cover release beta verifier script behavior.
/* oxlint-disable typescript/no-base-to-string -- fetch mock normalizes standard RequestInfo inputs for URL assertions. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePublicationDiagnostic,
  parsePublicationRun,
} from "../../scripts/frv-publication-status.mts";
import {
  downloadClawHubBootstrapReadback,
  fetchJsonWithRetry,
  fetchStatusWithRetry,
  parseNpmViewFields,
  parseReleaseVerifyBetaArgs,
  readBoundedJsonResponse,
  resolveOpenClawNpmPostpublishVerifier,
  runNpmViewWithRetry,
  runReleaseVerifierCommand,
  validateClawHubBootstrapEvidence,
  verifyBetaRelease,
} from "../../scripts/lib/release-beta-verifier.ts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = createTempDirTracker();
type CommandError = Error & {
  code?: string;
  signal?: NodeJS.Signals;
  status?: number;
  stderr?: string;
  stdout?: string;
};

function captureCommandError(run: () => unknown): CommandError {
  try {
    run();
  } catch (error) {
    return error as CommandError;
  }
  throw new Error("expected command to fail");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createStoredZip(files: Array<{ name: string; bytes: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, file.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + file.bytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

afterEach(() => {
  tempDirs.cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("verifyBetaRelease workflow outcomes", () => {
  const version = "2026.5.10-beta.3";

  function workflowFixture(
    overrides: Record<string, unknown> = {},
    telegram = true,
    npmError?: string,
    npm: {
      version: string;
      distTag: string;
      tags: Record<string, Record<string, string>>;
      transientlyMissing?: string;
      npm12?: boolean;
    } = {
      version,
      distTag: "beta",
      tags: { openclaw: { beta: version, latest: "2026.5.9" } },
    },
  ) {
    const rootDir = tempDirs.make("release-workflow-outcome-");
    const binDir = join(rootDir, "bin");
    mkdirSync(binDir);
    mkdirSync(join(rootDir, "extensions"));
    writeFileSync(join(rootDir, "package.json"), JSON.stringify({ version: npm.version }));
    writeFileSync(join(binDir, "npm.json"), JSON.stringify(npm));
    for (const name of Object.keys(npm.tags).filter((packageName) => packageName !== "openclaw")) {
      writePublishablePluginFixture(rootDir, {
        extensionId: name.slice("@openclaw/".length),
        packageName: name,
        version: npm.version,
        publishTo: "npm",
      });
    }
    const run = {
      workflowName: telegram ? "NPM Telegram Beta E2E" : "OpenClaw NPM Release",
      headBranch: "main",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      url: "https://example.invalid/runs/44",
      createdAt: "2026-07-10T00:00:00Z",
      updatedAt: "2026-07-10T00:02:00Z",
      jobs: [],
      ...overrides,
    };
    writeFileSync(join(binDir, "run.json"), JSON.stringify(run));
    const command = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(path.dirname(process.argv[1]), "commands.jsonl"), JSON.stringify([path.basename(process.argv[1]), ...args]) + "\\n");
if (path.basename(process.argv[1]) === "npm" && args[0] === "view") {
  if (${JSON.stringify(npmError ?? "")}) {
    process.stderr.write(${JSON.stringify(npmError ?? "")});
    process.exit(7);
  }
  const failures = path.join(path.dirname(process.argv[1]), "npm-failures.json");
  if (fs.existsSync(failures)) {
    const failure = JSON.parse(fs.readFileSync(failures, "utf8"))[args[1]];
    if (failure) { process.stderr.write(failure); process.exit(9); }
  }
  const npm = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), "npm.json")));
  const print = (value) => console.log(JSON.stringify(npm.npm12 ? [value] : value));
  const name = Object.keys(npm.tags).find((name) => args[1] === name || args[1] === name + "@" + npm.version);
  if (!name) throw new Error("Unexpected npm package: " + args[1]);
  if (args[2] === "dist-tags") {
    const visible = path.join(path.dirname(process.argv[1]), "npm-visible");
    if (npm.transientlyMissing === name && !fs.existsSync(visible)) {
      fs.writeFileSync(visible, "ready");
      console.error("npm ERR! code E404");
      process.exit(1);
    }
    if (args[1] === name && !npm.tags[name].latest) process.exit(0);
    print(npm.tags[name]);
  } else {
    if (args[1] !== name + "@" + npm.version) throw new Error("Expected an exact npm version");
    print({version: npm.version, "dist-tags": npm.tags[name], "dist.integrity": "sha512-test", "dist.tarball": "https://example.invalid/package.tgz"});
  }
} else if (args[0] === "run" && args[1] === "view" && args[2] === "44") {
  process.stdout.write(fs.readFileSync(path.join(path.dirname(process.argv[1]), "run.json")));
} else if (args[0] === "api" && args[1].endsWith("/actions/runs/34")) {
  process.stdout.write(fs.readFileSync(path.join(path.dirname(process.argv[1]), "bootstrap.json")));
} else if (args[0] === "api" && args[1].includes("/actions/runs/34/artifacts?")) {
  console.log(JSON.stringify({ artifacts: [] }));
} else {
  throw new Error("Unexpected release verifier command: " + args.join(" "));
}
`;
    for (const name of ["npm", "gh"]) {
      const file = join(binDir, name);
      writeFileSync(file, command);
      chmodSync(file, 0o755);
    }
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH}`);
    const args = parseReleaseVerifyBetaArgs([
      npm.version,
      "--dist-tag",
      npm.distTag,
      "--skip-postpublish",
      "--skip-github-release",
      "--skip-clawhub",
      "--workflow-ref",
      "main",
      telegram ? "--npm-telegram-run" : "--openclaw-npm-run",
      "44",
      "--evidence-out",
      "evidence.json",
    ]);
    return { args, rootDir, binDir, npm };
  }

  function runCli(fixture: ReturnType<typeof workflowFixture>, extra: string[] = [], preload = "") {
    const timers = join(fixture.rootDir, "timers.mjs");
    // Keep the production retry budget; only the isolated fixture's clock advances.
    writeFileSync(
      timers,
      `const delay = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => delay(fn, 0, ...args);\n${preload}`,
    );
    return spawnSync(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        "--import",
        timers,
        resolve("scripts/release-verify-beta.ts"),
        version,
        "--skip-postpublish",
        "--skip-github-release",
        "--skip-clawhub",
        "--openclaw-npm-run",
        "44",
        "--evidence-out",
        "evidence.json",
        ...extra,
      ],
      {
        cwd: fixture.rootDir,
        encoding: "utf8",
        timeout: 20_000,
        env: { PATH: `${fixture.binDir}:${process.env.PATH}` },
      },
    );
  }

  it.each(["E404", "ETARGET"])(
    "retains CLI diagnostics after core npm %s exhaustion without a success receipt",
    (code) => {
      const privateUrl = new URL("https://example.invalid/");
      privateUrl.username = "fixture-user";
      privateUrl.password = "fixture-password";
      privateUrl.searchParams.set("token", "fixture-token");
      const secret = `synthetic-secret /private/operator/token ${privateUrl.href}`;
      const fixture = workflowFixture({}, false, `${code}: ${secret}`);
      const result = runCli(fixture);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(code);
      expect(existsSync(join(fixture.rootDir, "evidence.json"))).toBe(false);
      const text = readFileSync(
        join(fixture.rootDir, "release-postpublish-diagnostics.json"),
        "utf8",
      );
      const diagnostic = JSON.parse(text);
      expect(diagnostic).toMatchObject({
        kind: "release-postpublish-diagnostics",
        verification: "failure",
        stages: {
          coreNpm: { state: "failure", error: { class: "registry-not-visible", status: 7 } },
          pluginNpm: { state: "unattempted" },
          openclawNpm: { state: "unattempted" },
        },
        children: { openclawNpm: { suppliedRunId: "44", runAttempt: null } },
      });
      expect(text).not.toMatch(/synthetic-secret|private\/operator|password|token=secret/u);
      const commands = readFileSync(join(fixture.binDir, "commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(commands).toHaveLength(30);
      expect(commands.every((args) => args[0] === "npm" && args[1] === "view")).toBe(true);
    },
  );

  it("retains successful core readback when the CLI later rejects a workflow", () => {
    const fixture = workflowFixture({ conclusion: "failure" }, false);
    const result = runCli(fixture);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("OpenClaw NPM Release: run 44 is completed/failure");
    expect(existsSync(join(fixture.rootDir, "evidence.json"))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"), "utf8"),
      ),
    ).toMatchObject({
      verification: "failure",
      stages: {
        coreNpm: { state: "success", publication: "observed" },
        openclawNpm: { state: "failure" },
        evidence: { state: "unattempted" },
      },
      children: { openclawNpm: { suppliedRunId: "44", runAttempt: null } },
    });
  });

  it("initializes CLI diagnostics before checkout version verification", () => {
    const fixture = workflowFixture({}, false);
    writeFileSync(join(fixture.rootDir, "package.json"), JSON.stringify({ version: "2026.1.1" }));
    const result = runCli(fixture);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("package.json version is 2026.1.1");
    expect(
      JSON.parse(
        readFileSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"), "utf8"),
      ),
    ).toMatchObject({
      verification: "failure",
      stages: { checkout: { state: "failure" }, coreNpm: { state: "unattempted" } },
    });
    expect(existsSync(join(fixture.binDir, "commands.jsonl"))).toBe(false);
  });

  it.each([true, false])(
    "retains only bound bootstrap attempts before later artifact failure (bound=%s)",
    (bound) => {
      const fixture = workflowFixture({}, false);
      const releaseSha = "a".repeat(40);
      writeFileSync(join(fixture.binDir, "git"), `#!/bin/sh\nprintf '%s\\n' '${releaseSha}'\n`, {
        mode: 0o755,
      });
      writeFileSync(
        join(fixture.binDir, "bootstrap.json"),
        JSON.stringify({
          id: bound ? 34 : 35,
          name: "Plugin ClawHub New",
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: "b".repeat(40),
          run_attempt: 3,
          path: ".github/workflows/plugin-clawhub-new.yml",
          status: "completed",
          conclusion: "success",
        }),
      );
      const result = runCli(fixture, [
        "--release-sha",
        releaseSha,
        "--plugin-clawhub-bootstrap-run",
        "34",
        "--clawhub-bootstrap-plugins",
        "@openclaw/example",
      ]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        bound ? "must have exactly one clawhub-bootstrap-readback-34-3" : "run id is 35",
      );
      const diagnostic = JSON.parse(
        readFileSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"), "utf8"),
      );
      expect(diagnostic.stages.pluginClawHubBootstrap.state).toBe("failure");
      expect(diagnostic.children.pluginClawHubBootstrap).toMatchObject({
        suppliedRunId: "34",
        runAttempt: bound ? "3" : null,
        producerRunAttempt: null,
        status: bound ? "completed" : "unknown",
        conclusion: bound ? "success" : "unknown",
      });
      expect(existsSync(join(fixture.rootDir, "evidence.json"))).toBe(false);
    },
  );

  it.each(["npm", "clawhub"] as const)(
    "retains completed packages and later unattempted packages after %s fails",
    async (surface) => {
      const fixture = workflowFixture({}, false);
      for (const extensionId of ["first", "middle", "last"]) {
        writePublishablePluginFixture(fixture.rootDir, {
          version,
          extensionId,
          publishTo: "both",
        });
        fixture.npm.tags[`@openclaw/${extensionId}`] = { beta: version };
      }
      writeFileSync(join(fixture.binDir, "npm.json"), JSON.stringify(fixture.npm));
      // The collector's order is alphabetical: first, last, middle.
      if (surface === "npm") {
        writeFileSync(
          join(fixture.binDir, "npm-failures.json"),
          JSON.stringify({
            [`@openclaw/last@${version}`]: "EACCES: synthetic-secret",
          }),
        );
      } else {
        fixture.args.skipClawHub = false;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string) => {
            if (input.includes(encodeURIComponent("@openclaw/last"))) {
              return new Response("synthetic-secret", { status: 403 });
            }
            return Response.json({ package: { tags: { beta: version } } });
          }),
        );
      }
      await expect(verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir })).rejects.toThrow();
      const diagnostic = JSON.parse(
        readFileSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"), "utf8"),
      );
      const stage = diagnostic.stages[surface === "npm" ? "pluginNpm" : "clawHub"];
      expect(stage.state).toBe("failure");
      expect(stage.packages).toMatchObject([
        { name: "@openclaw/first", state: "success", publication: "observed" },
        { name: "@openclaw/last", state: "failure", publication: "unknown" },
        { name: "@openclaw/middle", state: "unattempted", publication: "unknown" },
      ]);
      expect(diagnostic.stages.coreNpm.state).toBe("success");
      expect(diagnostic.stages.openclawNpm.state).toBe("unattempted");
      expect(existsSync(join(fixture.rootDir, "evidence.json"))).toBe(false);
    },
  );

  it("keeps the primary CLI failure when diagnostic initialization cannot write", () => {
    const fixture = workflowFixture({ conclusion: "failure" }, false);
    mkdirSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"));
    const result = runCli(fixture);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("diagnostics unavailable");
    expect(result.stderr).toContain("OpenClaw NPM Release: run 44 is completed/failure");
    expect(existsSync(join(fixture.rootDir, "evidence.json"))).toBe(false);
  });

  it("retains the last valid atomic diagnostic when updates and the verifier both fail", () => {
    const fixture = workflowFixture({}, false, "EACCES: primary-registry-denial");
    const result = runCli(
      fixture,
      [],
      `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const link = fs.linkSync;
fs.linkSync = (source, target) => {
  link(source, target);
  fs.copyFileSync(target, target + ".original");
};
fs.renameSync = () => { throw new Error("synthetic-secret update failure"); };
syncBuiltinESMExports();
`,
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("primary-registry-denial");
    expect(result.stderr).toContain("diagnostics unavailable");
    expect(result.stderr).not.toContain("synthetic-secret");
    const diagnosticPath = join(fixture.rootDir, "release-postpublish-diagnostics.json");
    expect(readFileSync(diagnosticPath)).toEqual(readFileSync(`${diagnosticPath}.original`));
    expect(JSON.parse(readFileSync(diagnosticPath, "utf8")).verification).toBe("unattempted");
    expect(existsSync(join(fixture.rootDir, "evidence.json"))).toBe(false);
  });

  it.each(["stale", "unwritable"] as const)(
    "does not turn a %s success-output path into a successful CLI result",
    (mode) => {
      const fixture = workflowFixture({}, false);
      const evidencePath = join(fixture.rootDir, "evidence.json");
      if (mode === "stale") {
        writeFileSync(evidencePath, "previous invocation\n");
      } else {
        mkdirSync(evidencePath);
      }
      const result = runCli(fixture);
      expect(result.status, result.stderr).toBe(1);
      const diagnostic = JSON.parse(
        readFileSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"), "utf8"),
      );
      expect(diagnostic).toMatchObject({
        verification: "success",
        stages: { evidence: { state: "failure", error: { class: "evidence-write-failure" } } },
      });
      if (mode === "stale") {
        expect(readFileSync(evidencePath, "utf8")).toBe("previous invocation\n");
      }
    },
  );

  it("bounds and validates selected diagnostic metadata without retaining hostile inputs", () => {
    const fixture = workflowFixture({}, false);
    writeFileSync(join(fixture.rootDir, "package.json"), JSON.stringify({ version: "2026.1.1" }));
    const names = Array.from({ length: 300 }, (_, i) => `@openclaw/plugin-${i}`);
    const result = runCli(fixture, [
      "--plugins",
      names.join(","),
      "--workflow-ref",
      "https://example.invalid/?token=synthetic-secret",
    ]);
    expect(result.status).toBe(1);
    const text = readFileSync(
      join(fixture.rootDir, "release-postpublish-diagnostics.json"),
      "utf8",
    );
    const diagnostic = JSON.parse(text);
    expect(diagnostic.selection.plugins).toHaveLength(256);
    expect(diagnostic.selection.pluginsTruncated).toBe(true);
    expect(diagnostic.selection.workflowRef).toBeNull();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128 * 1024);
    expect(text).not.toMatch(/password|token=|synthetic-secret/u);
  });

  it.each(
    [
      { label: "missing", beta: undefined, fails: true },
      { label: "older same-train prerelease", beta: "2026.9.3-beta.1", fails: true },
      { label: "older final", beta: "2026.9.1", fails: true },
      { label: "equal", beta: "2026.9.3", fails: false },
      { label: "newer next-train prerelease", beta: "2026.9.4-beta.1", fails: false },
    ].flatMap(({ label, beta, fails }) =>
      [false, true].map((npm12) => ({ label, beta, fails, npm12 })),
    ),
  )(
    "enforces the beta floor for a plugin with $label beta (npm 12: $npm12)",
    async ({ beta, fails, npm12 }) => {
      const latest = "2026.9.3";
      const fixture = workflowFixture({}, true, undefined, {
        version: latest,
        distTag: "latest",
        npm12,
        tags: {
          openclaw: { latest, beta: latest },
          "@openclaw/demo": { latest, ...(beta === undefined ? {} : { beta }) },
        },
      });

      const verification = verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir });
      if (fails) {
        await expect(verification).rejects.toThrow(
          `@openclaw/demo: beta=${beta ?? "<missing>"}, latest=${latest}`,
        );
      } else {
        await expect(verification).resolves.toContain("plugin npm OK: 1");
      }
    },
  );

  it("lists every core and plugin beta floor violation together", async () => {
    const latest = "2026.9.3";
    const fixture = workflowFixture({}, true, undefined, {
      version: latest,
      distTag: "latest",
      tags: {
        openclaw: { latest, beta: "2026.9.1" },
        "@openclaw/demo": { latest, beta: "2026.9.3-beta.1" },
        "@openclaw/other": { latest },
      },
    });

    const verification = verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir });
    await expect(verification).rejects.toThrow(
      "openclaw: beta=2026.9.1, latest=2026.9.3\n" +
        "@openclaw/demo: beta=2026.9.3-beta.1, latest=2026.9.3\n" +
        "@openclaw/other: beta=<missing>, latest=2026.9.3",
    );
    await expect(verification).rejects.toThrow("npm dist-tag add <pkg>@<latest> beta");
  });

  it.each([false, true])(
    "queries a beta-only plugin without latest (npm 12 and initial E404: %s)",
    async (transientlyMissing) => {
      const beta = "2026.9.4-beta.1";
      const fixture = workflowFixture({}, true, undefined, {
        version: beta,
        distTag: "beta",
        npm12: transientlyMissing,
        tags: {
          openclaw: { latest: "2026.9.3", beta },
          "@openclaw/demo": { beta },
        },
        transientlyMissing: transientlyMissing ? "@openclaw/demo" : undefined,
      });

      await expect(
        verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir }),
      ).resolves.toContain("plugin npm OK: 1");
    },
  );

  it("retains a core beta failure if later plugin verification is interrupted", () => {
    const fixture = workflowFixture({}, true, undefined, {
      version,
      distTag: "beta",
      tags: {
        openclaw: { beta: version, latest: "2026.5.10" },
        "@openclaw/demo": { beta: version },
      },
    });
    const result = runCli(
      fixture,
      [],
      `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const exec = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  if (command === "npm" && args?.[1]?.startsWith("@openclaw/demo@")) process.exit(23);
  return exec(command, args, options);
};
syncBuiltinESMExports();`,
    );
    expect(result.status, result.stderr).toBe(23);
    const diagnostic: unknown = JSON.parse(
      readFileSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"), "utf8"),
    );
    expect(diagnostic).toMatchObject({
      verification: "failure",
      stages: {
        coreNpm: { state: "failure", publication: "observed" },
        pluginNpm: { state: "started" },
      },
    });
    expect(existsSync(join(fixture.rootDir, "evidence.json"))).toBe(false);
  });

  it.each([
    { coreStale: true, pluginStale: false },
    { coreStale: false, pluginStale: true },
    { coreStale: true, pluginStale: true },
  ])("retains publication facts when beta floors fail: %j", async ({ coreStale, pluginStale }) => {
    vi.stubEnv("GITHUB_RUN_ID", "");
    const latest = "2026.9.3";
    const fixture = workflowFixture({}, true, undefined, {
      version: latest,
      distTag: "latest",
      npm12: true,
      tags: {
        openclaw: { latest, beta: coreStale ? "2026.9.1" : latest },
        "@openclaw/a-plugin": { latest, beta: pluginStale ? "2026.9.3-beta.1" : latest },
        "@openclaw/z-healthy": { latest, beta: latest },
      },
    });

    await expect(verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir })).rejects.toThrow(
      "npm beta must be at or above latest",
    );
    const diagnostic: unknown = JSON.parse(
      readFileSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"), "utf8"),
    );
    expect(diagnostic).toMatchObject({
      verification: "failure",
      currentStage: coreStale ? "coreNpm" : "pluginNpm",
      stages: {
        coreNpm: {
          state: coreStale ? "failure" : "success",
          publication: "observed",
        },
        pluginNpm: {
          state: pluginStale ? "failure" : "success",
          packages: [
            {
              name: "@openclaw/a-plugin",
              state: pluginStale ? "failure" : "success",
              publication: "observed",
              error: pluginStale ? { class: "selector-mismatch" } : null,
            },
            {
              name: "@openclaw/z-healthy",
              state: "success",
              publication: "observed",
              error: null,
            },
          ],
        },
        evidence: { state: "unattempted" },
      },
    });
    expect(existsSync(join(fixture.rootDir, "evidence.json"))).toBe(false);
    const run = parsePublicationRun(
      {
        id: 44,
        run_attempt: 1,
        workflow_id: 2,
        repository: { full_name: "openclaw/openclaw" },
        head_sha: "a".repeat(40),
        head_branch: "main",
        path: ".github/workflows/openclaw-release-publish.yml",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "failure",
      },
      "openclaw/openclaw",
      "44",
    );
    // The existing v1 reader validates the shape before rejecting this unbound fixture.
    expect(parsePublicationDiagnostic(diagnostic, run)).toBeNull();
  });

  it.each([
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "cancelled" },
    { status: "completed", conclusion: "skipped" },
    { status: "completed", conclusion: "success" },
  ])(
    "records optional Telegram as advisory without relabeling $status/$conclusion",
    async (run) => {
      const fixture = workflowFixture(run);

      const lines = await verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir });
      const evidence = JSON.parse(readFileSync(join(fixture.rootDir, "evidence.json"), "utf8"));

      expect(lines).toContain("openclaw npm OK: 2026.5.10-beta.3 (beta)");
      expect(lines.some((line) => line.startsWith("NPM Telegram Beta E2E advisory:"))).toBe(true);
      expect(lines.some((line) => line.startsWith("NPM Telegram Beta E2E OK:"))).toBe(false);
      expect(evidence.workflowRuns).toEqual([
        expect.objectContaining({
          id: "44",
          advisory: {
            status: run.status,
            conclusion: run.conclusion ?? "unavailable",
            failedJobs: [],
          },
        }),
      ]);
      const diagnostic = JSON.parse(
        readFileSync(join(fixture.rootDir, "release-postpublish-diagnostics.json"), "utf8"),
      );
      expect(diagnostic.children.npmTelegram).toMatchObject({
        status: run.status,
        conclusion: run.conclusion,
        runAttempt: null,
      });
      expect(diagnostic.stages.clawHub.state).toBe("skipped");
      expect(diagnostic.stages.githubRelease.state).toBe("skipped");
    },
  );

  it("requires a terminal Telegram attempt before recording advisory evidence", async () => {
    const fixture = workflowFixture({ status: "in_progress", conclusion: null });

    await expect(verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir })).rejects.toThrow(
      "NPM Telegram Beta E2E: run 44 is in_progress/<missing>",
    );
  });

  it("preserves a failed Telegram job even when its advisory workflow concludes success", async () => {
    const fixture = workflowFixture({
      jobs: [{ name: "Run package Telegram E2E", conclusion: "failure" }],
    });

    const lines = await verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir });
    const evidence = JSON.parse(readFileSync(join(fixture.rootDir, "evidence.json"), "utf8"));

    expect(lines.join("\n")).toContain("Run package Telegram E2E");
    expect(evidence.workflowRuns[0].advisory).toEqual({
      status: "completed",
      conclusion: "success",
      failedJobs: ["Run package Telegram E2E"],
    });
  });

  it.each([
    { override: { workflowName: "Other Workflow" }, error: "workflow is Other Workflow" },
    { override: { event: "push" }, error: "event is push" },
    { override: { headBranch: "untrusted" }, error: "branch is untrusted" },
  ])("keeps Telegram identity validation strict: $error", async ({ override, error }) => {
    const fixture = workflowFixture({ conclusion: "failure", ...override });

    await expect(verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir })).rejects.toThrow(
      error,
    );
  });

  it.each([
    { conclusion: "failure" },
    { jobs: [{ name: "Publish package", conclusion: "failure" }] },
  ])("keeps non-Telegram workflow failures blocking: %j", async (run) => {
    const fixture = workflowFixture(run, false);

    await expect(verifyBetaRelease(fixture.args, { rootDir: fixture.rootDir })).rejects.toThrow(
      "OpenClaw NPM Release: run 44 is",
    );
  });
});

describe("parseReleaseVerifyBetaArgs", () => {
  it("defaults beta verification to the matching tag and repo", () => {
    expect(parseReleaseVerifyBetaArgs(["2026.5.10-beta.3"])).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      releaseSha: undefined,
      workflowRef: undefined,
      clawHubWorkflowRef: undefined,
      pluginSelection: [],
      clawHubBootstrapPlugins: [],
      evidenceOut: undefined,
      postpublishVerifier: undefined,
      skipPostpublish: false,
      skipGitHubRelease: false,
      skipClawHub: false,
      rerunFailedClawHub: false,
      workflowRuns: {},
    });
  });

  it("parses child run IDs and repair flags", () => {
    expect(
      parseReleaseVerifyBetaArgs([
        "--",
        "2026.5.10-beta.3",
        "--workflow-ref",
        "release/2026.5.10",
        "--release-sha",
        "a".repeat(40),
        "--clawhub-workflow-ref",
        "v2026.5.10-beta.3",
        "--plugins",
        "@openclaw/plugin-a,@openclaw/plugin-b",
        "--full-release-validation-run",
        "10",
        "--openclaw-npm-run",
        "11",
        "--plugin-npm-run",
        "22",
        "--plugin-clawhub-run",
        "33",
        "--plugin-clawhub-bootstrap-run",
        "34",
        "--clawhub-bootstrap-plugins",
        "@openclaw/plugin-b",
        "--npm-telegram-run",
        "44",
        "--evidence-out",
        ".artifacts/release-evidence.json",
        "--postpublish-verifier",
        "/tmp/trusted-postpublish.ts",
        "--skip-github-release",
        "--skip-clawhub",
        "--rerun-failed-clawhub",
      ]),
    ).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      releaseSha: "a".repeat(40),
      workflowRef: "release/2026.5.10",
      clawHubWorkflowRef: "v2026.5.10-beta.3",
      pluginSelection: ["@openclaw/plugin-a", "@openclaw/plugin-b"],
      clawHubBootstrapPlugins: ["@openclaw/plugin-b"],
      evidenceOut: ".artifacts/release-evidence.json",
      postpublishVerifier: "/tmp/trusted-postpublish.ts",
      skipPostpublish: false,
      skipGitHubRelease: true,
      skipClawHub: true,
      rerunFailedClawHub: true,
      workflowRuns: {
        fullReleaseValidation: "10",
        openclawNpm: "11",
        pluginNpm: "22",
        pluginClawHub: "33",
        pluginClawHubBootstrap: "34",
        npmTelegram: "44",
      },
    });
  });

  it("only accepts the trusted tooling postpublish verifier override", () => {
    expect(resolveOpenClawNpmPostpublishVerifier("/tmp/release")).toBe(
      "/tmp/release/scripts/openclaw-npm-postpublish-verify.ts",
    );
    const trustedVerifier = resolve("scripts/openclaw-npm-postpublish-verify.ts");
    expect(resolveOpenClawNpmPostpublishVerifier("/tmp/release", trustedVerifier)).toBe(
      trustedVerifier,
    );
    expect(() =>
      resolveOpenClawNpmPostpublishVerifier("/tmp/release", "/tmp/untrusted-verifier.ts"),
    ).toThrow("must select the trusted tooling verifier");
    expect(() =>
      parseReleaseVerifyBetaArgs([
        "2026.5.10-beta.3",
        "--postpublish-verifier",
        trustedVerifier,
        "--skip-postpublish",
      ]),
    ).toThrow("cannot be combined");
  });

  it("requires exact target and package inputs for bootstrap run verification", () => {
    expect(() =>
      parseReleaseVerifyBetaArgs(["2026.5.10-beta.3", "--plugin-clawhub-bootstrap-run", "34"]),
    ).toThrow("--plugin-clawhub-bootstrap-run requires --release-sha");
    expect(() =>
      parseReleaseVerifyBetaArgs([
        "2026.5.10-beta.3",
        "--release-sha",
        "a".repeat(40),
        "--plugin-clawhub-bootstrap-run",
        "34",
      ]),
    ).toThrow("--plugin-clawhub-bootstrap-run requires --clawhub-bootstrap-plugins");
    expect(() =>
      parseReleaseVerifyBetaArgs([
        "2026.5.10-beta.3",
        "--clawhub-bootstrap-plugins",
        "@openclaw/plugin-b",
      ]),
    ).toThrow("--clawhub-bootstrap-plugins requires --plugin-clawhub-bootstrap-run");
  });
});

describe("validateClawHubBootstrapEvidence", () => {
  const clawhubToolchainIntegrity =
    "sha512-VwM6FQrZVarFRDiEqG42npUeyCu/iLhPnpO+b7kKIGRXv+TA6Lb8pboHnIgT6cmjFEnW3j/pTbshWeDQMQ7QWQ==";
  const clawhubToolchainSha256 = sha256(
    readFileSync(".github/release/clawhub-cli/package-lock.json"),
  );
  const clawhubToolchainVersion = "0.23.3";
  const releaseSha = "a".repeat(40);
  const workflowSha = "b".repeat(40);
  const packageSha = "c".repeat(64);
  const readbackSha = "d".repeat(64);
  const run = {
    id: 34,
    name: "Plugin ClawHub New",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: workflowSha,
    path: ".github/workflows/plugin-clawhub-new.yml@refs/heads/main",
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/openclaw/openclaw/actions/runs/34",
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:02:00Z",
  };
  const workflowRun = {
    id: 34,
    head_branch: "main",
    head_sha: workflowSha,
  };
  const readbackArtifact = {
    id: 45,
    name: "clawhub-bootstrap-readback-34-2",
    digest: `sha256:${readbackSha}`,
    size_in_bytes: 1,
    expired: false,
    workflow_run: workflowRun,
  };
  const packageArtifact = {
    id: 46,
    name: `clawhub-bootstrap-${releaseSha.slice(0, 12)}-34-1`,
    digest: `sha256:${packageSha}`,
    expired: false,
    workflow_run: workflowRun,
  };
  const evidence = {
    schemaVersion: 2,
    repository: "openclaw/openclaw",
    targetSha: releaseSha,
    workflowSha,
    runId: "34",
    producerRunAttempt: "1",
    terminalRunAttempt: "2",
    artifactName: packageArtifact.name,
    artifactId: "46",
    artifactDigest: packageSha,
    clawhubToolchainIntegrity,
    clawhubToolchainSha256,
    clawhubToolchainVersion,
    requestedPlugins: ["@openclaw/meta"],
    verificationMode: "postpublish",
    packages: [
      {
        packageName: "@openclaw/meta",
        version: "2026.7.1-beta.3",
        expectedSha256: packageSha,
        expectedSize: 123,
        registrySha256: packageSha,
        registrySize: 123,
        npmIntegrity: "sha512-test",
        npmShasum: "1".repeat(40),
        artifactMetadata: {
          kind: "npm-pack",
          sha256: packageSha,
          size: 123,
          npmIntegrity: "sha512-test",
          npmShasum: "1".repeat(40),
          packageName: "@openclaw/meta",
          version: "2026.7.1-beta.3",
        },
      },
    ],
  };

  function validate(
    overrides: {
      run?: unknown;
      readbackArtifact?: unknown;
      packageArtifact?: unknown;
      evidence?: unknown;
      expectedPackages?: string[];
    } = {},
  ) {
    return validateClawHubBootstrapEvidence({
      repo: "openclaw/openclaw",
      runId: "34",
      releaseSha,
      expectedVersion: "2026.7.1-beta.3",
      expectedPackages: overrides.expectedPackages ?? ["@openclaw/meta"],
      run: overrides.run ?? run,
      readbackArtifact: overrides.readbackArtifact ?? readbackArtifact,
      readbackArchiveSha256: readbackSha,
      packageArtifact: overrides.packageArtifact ?? packageArtifact,
      evidence: overrides.evidence ?? evidence,
    });
  }

  it("binds the exact main run, attempt, target, package set, and artifact tuple", () => {
    expect(validate()).toMatchObject({
      id: "34",
      label: "Plugin ClawHub New",
      durationSeconds: 120,
      bootstrapEvidence: {
        targetSha: releaseSha,
        workflowSha,
        workflowPath: ".github/workflows/plugin-clawhub-new.yml",
        producerRunAttempt: "1",
        terminalRunAttempt: "2",
        readbackArtifactId: "45",
        readbackArtifactDigest: readbackSha,
        packageArtifactId: "46",
        packageArtifactDigest: packageSha,
        packageCount: 1,
        clawhubToolchainIntegrity,
        clawhubToolchainSha256,
        clawhubToolchainVersion,
      },
    });
  });

  it("rejects legacy release-ref runs and mismatched target/package evidence", () => {
    expect(() => validate({ run: { ...run, head_branch: "release/2026.7.1" } })).toThrow(
      "not dispatched from trusted main",
    );
    expect(() =>
      validate({
        run: { ...run, path: ".github/workflows/not-plugin-clawhub-new.yml" },
      }),
    ).toThrow("unexpected workflow path");
    expect(() => validate({ evidence: { ...evidence, targetSha: "e".repeat(40) } })).toThrow(
      "target SHA mismatch",
    );
    expect(() => validate({ expectedPackages: ["@openclaw/other"] })).toThrow(
      "requested package set mismatch",
    );
  });

  it("rejects stale attempts, changed artifact bytes, and metadata drift", () => {
    expect(() =>
      validate({
        readbackArtifact: {
          ...readbackArtifact,
          name: "clawhub-bootstrap-readback-34-1",
        },
      }),
    ).toThrow("does not bind the run attempt");
    expect(() =>
      validate({
        evidence: { ...evidence, terminalRunAttempt: "1" },
      }),
    ).toThrow("readback evidence run tuple mismatch");
    expect(() =>
      validate({
        evidence: { ...evidence, producerRunAttempt: "3" },
      }),
    ).toThrow("producer attempt is newer than its terminal attempt");
    expect(() =>
      validate({
        packageArtifact: {
          ...packageArtifact,
          name: `clawhub-bootstrap-${releaseSha.slice(0, 12)}-34-2`,
        },
        evidence: {
          ...evidence,
          artifactName: `clawhub-bootstrap-${releaseSha.slice(0, 12)}-34-2`,
        },
      }),
    ).toThrow("package artifact name does not bind the target and attempt");
    expect(() =>
      validate({
        packageArtifact: {
          ...packageArtifact,
          digest: `sha256:${"e".repeat(64)}`,
        },
      }),
    ).toThrow("package artifact digest mismatch");
    expect(() =>
      validate({
        evidence: {
          ...evidence,
          packages: [
            {
              ...expectDefined(evidence.packages[0], "first beta release package evidence"),
              artifactMetadata: {
                ...expectDefined(evidence.packages[0], "first beta release package evidence")
                  .artifactMetadata,
                npmIntegrity: "sha512-different",
              },
            },
          ],
        },
      }),
    ).toThrow("artifact metadata does not match downloaded bytes");
    expect(() =>
      validate({
        evidence: {
          ...evidence,
          clawhubToolchainSha256: "e".repeat(64),
        },
      }),
    ).toThrow("clawhubToolchainSha256 mismatch");
  });
});

describe("downloadClawHubBootstrapReadback", () => {
  const workflowSha = "b".repeat(40);
  const run = {
    id: 34,
    name: "Plugin ClawHub New",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: workflowSha,
    path: ".github/workflows/plugin-clawhub-new.yml@refs/heads/main",
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
  };
  const workflowAttempt = {
    id: 34,
    run_attempt: 2,
    head_sha: workflowSha,
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/plugin-clawhub-new.yml",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "openclaw/openclaw" },
    head_repository: { full_name: "openclaw/openclaw" },
  };

  function createFixture(
    archive: Buffer,
    overrides: {
      artifactMetadata?: Record<string, unknown>;
      workflowAttempt?: Record<string, unknown>;
    } = {},
  ) {
    const readbackArtifact = {
      id: 45,
      name: "clawhub-bootstrap-readback-34-2",
      digest: `sha256:${sha256(archive)}`,
      size_in_bytes: archive.length,
      expired: false,
      workflow_run: {
        id: 34,
        head_branch: "main",
        head_sha: workflowSha,
      },
    };
    const artifactMetadata = {
      ...readbackArtifact,
      ...overrides.artifactMetadata,
    };
    const attemptMetadata = {
      ...workflowAttempt,
      ...overrides.workflowAttempt,
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/actions/artifacts/45")) {
        return Response.json(artifactMetadata);
      }
      if (url.endsWith("/actions/runs/34/attempts/2")) {
        return Response.json(attemptMetadata);
      }
      if (url.endsWith("/actions/artifacts/45/zip")) {
        return new Response(archive as unknown as BodyInit, {
          headers: { "content-length": String(archive.length) },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    return { fetchImpl, readbackArtifact };
  }

  async function download(
    archive: Buffer,
    overrides?: Parameters<typeof createFixture>[1],
  ): Promise<{
    result: Awaited<ReturnType<typeof downloadClawHubBootstrapReadback>>;
    requests: number;
  }> {
    const fixture = createFixture(archive, overrides);
    const result = await downloadClawHubBootstrapReadback({
      repo: "openclaw/openclaw",
      runId: "34",
      run,
      readbackArtifact: fixture.readbackArtifact,
      token: "test-token",
      fetchImpl: fixture.fetchImpl,
      retryAttempts: 1,
      retryDelayMs: 1,
      timeoutMs: 1_000,
    });
    return { result, requests: fixture.fetchImpl.mock.calls.length };
  }

  it("downloads one exact readback file from the bound successful main attempt", async () => {
    const evidence = { schemaVersion: 2, targetSha: "a".repeat(40) };
    const archive = createStoredZip([
      {
        name: "clawhub-bootstrap-readback.json",
        bytes: Buffer.from(JSON.stringify(evidence)),
      },
    ]);

    await expect(download(archive)).resolves.toEqual({
      result: {
        value: evidence,
        archiveSha256: sha256(archive),
      },
      requests: 3,
    });
  });

  it("rejects stale live artifact and workflow-attempt metadata", async () => {
    const archive = createStoredZip([
      {
        name: "clawhub-bootstrap-readback.json",
        bytes: Buffer.from("{}"),
      },
    ]);

    await expect(
      download(archive, {
        artifactMetadata: { digest: `sha256:${"c".repeat(64)}` },
      }),
    ).rejects.toThrow("artifact metadata does not match the immutable publication tuple");
    await expect(
      download(archive, {
        workflowAttempt: { run_attempt: 1 },
      }),
    ).rejects.toThrow("workflow run does not match the immutable publication tuple");
  });

  it("rejects hostile or expanded readback inventories through the shared ZIP policy", async () => {
    const hostileArchives = [
      createStoredZip([{ name: "../clawhub-bootstrap-readback.json", bytes: Buffer.from("{}") }]),
      createStoredZip([
        { name: "clawhub-bootstrap-readback.json", bytes: Buffer.from("{}") },
        { name: "extra.json", bytes: Buffer.from("{}") },
      ]),
    ];

    for (const archive of hostileArchives) {
      await expect(download(archive)).rejects.toThrow(/(?:Unsafe ZIP entry|Actions artifact ZIP)/u);
    }
  });
});

describe("parseNpmViewFields", () => {
  it("accepts keyed npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags.beta": "2026.5.10-beta.3",
          "dist.integrity": "sha512-test",
          "dist.tarball": "https://registry.example/openclaw.tgz",
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
      tarball: "https://registry.example/openclaw.tgz",
    });
  });

  it("accepts nested npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags": { beta: "2026.5.10-beta.3" },
          dist: {
            integrity: "sha512-test",
            tarball: "https://registry.example/openclaw.tgz",
          },
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
      tarball: "https://registry.example/openclaw.tgz",
    });
  });
});

describe("runNpmViewWithRetry", () => {
  it("retries transient registry failures with online metadata reads", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];

    await expect(
      runNpmViewWithRetry(["view", "openclaw@2026.5.10-beta.3", "version", "--json"], {
        attempts: 3,
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
        run: (args) => {
          calls.push(args);
          if (calls.length < 3) {
            throw Object.assign(new Error("npm registry has not propagated the release yet"), {
              code: "E404",
            });
          }
          return '"2026.5.10-beta.3"';
        },
      }),
    ).resolves.toBe('"2026.5.10-beta.3"');

    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.at(-1) === "--prefer-online")).toBe(true);
    expect(delays).toEqual([1000, 2000]);
  });

  it("fails a timed-out npm read after one attempt and reaps the child", async () => {
    const delay = vi.fn(async () => {});
    let calls = 0;
    let timeoutError: CommandError | undefined;
    const result = runNpmViewWithRetry(["view", "openclaw", "version"], {
      attempts: 3,
      delay,
      run: () => {
        calls += 1;
        try {
          return runReleaseVerifierCommand(
            process.execPath,
            ["-e", "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"],
            { timeoutMs: 5_000 },
          );
        } catch (error) {
          timeoutError = error as CommandError;
          throw error;
        }
      },
    });
    await expect(result).rejects.toMatchObject({ code: "ETIMEDOUT", signal: "SIGKILL" });
    expect(calls).toBe(1);
    expect(delay).not.toHaveBeenCalled();
    const observedTimeoutError = expectDefined(timeoutError, "timeout command error");
    const childPid = Number(observedTimeoutError.stdout?.trim());
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});

describe("runReleaseVerifierCommand", () => {
  it("trims successful captured output", () => {
    expect(
      runReleaseVerifierCommand(process.execPath, [
        "-e",
        'process.stdout.write("  release ready  \\n")',
      ]),
    ).toBe("release ready");
  });

  it("preserves stdout and stderr when a command exits nonzero", () => {
    const error = captureCommandError(() =>
      runReleaseVerifierCommand(process.execPath, [
        "-e",
        'process.stdout.write("partial output"); process.stderr.write("failure detail"); process.exit(7)',
      ]),
    );
    expect(error).toMatchObject({ status: 7 });
    expect(error.stdout).toContain("partial output");
    expect(error.stderr).toContain("failure detail");
  });

  it("fails when captured output exceeds the command buffer", () => {
    const error = captureCommandError(() =>
      runReleaseVerifierCommand(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(4096))'],
        { maxBufferBytes: 64 },
      ),
    );
    expect(error.code).toBe("ENOBUFS");
    expect(error.stdout).toContain("x");
  });
});

describe("fetchStatusWithRetry", () => {
  it("cancels retryable and returned GET response bodies", async () => {
    vi.useFakeTimers();
    const canceled: string[] = [];
    const responses = [
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled.push("retry");
          },
        }),
        { status: 500 },
      ),
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled.push("final");
          },
        }),
        { status: 200 },
      ),
    ];
    const fetchImpl = vi.fn(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected fetch call");
      }
      return response;
    });
    vi.stubGlobal("fetch", fetchImpl);

    const status = fetchStatusWithRetry("https://clawhub.test/api/v1/package", "GET");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(status).resolves.toBe(200);
    expect(canceled).toEqual(["retry", "final"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("fetchJsonWithRetry", () => {
  it("retries invalid and failed response bodies within the attempt budget", async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{invalid"))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("truncated"));
            },
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(
      fetchJsonWithRetry("https://clawhub.test/api/v1/package", {
        attempts: 3,
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("fails permanent client errors without retrying", async () => {
    const delay = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(
      fetchJsonWithRetry("https://clawhub.test/api/v1/package", {
        attempts: 3,
        delay,
        fetchImpl,
      }),
    ).rejects.toThrow("returned HTTP 403");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});

describe("readBoundedJsonResponse", () => {
  it("parses JSON bodies within the release verifier limit", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"ok":true}'), "ClawHub package", 64),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects oversized JSON bodies by content length", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response("{}", { headers: { "content-length": "65" } }),
        "ClawHub package",
        64,
      ),
    ).rejects.toThrow("ClawHub package response body exceeded 64 bytes");
  });

  it("rejects oversized streamed JSON bodies", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"padding":"too-large"}'), "ClawHub package", 8),
    ).rejects.toThrow("ClawHub package response body exceeded 8 bytes");
  });

  it("keeps ClawHub request timeouts active while reading JSON bodies", async () => {
    let canceled = false;
    const abortController = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
        cancel() {
          canceled = true;
        },
      }),
    );

    const json = readBoundedJsonResponse(response, "ClawHub package", 64, {
      signal: abortController.signal,
    });

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 0);
    });
    abortController.abort(new Error("ClawHub body timed out"));

    await expect(json).rejects.toThrow("ClawHub body timed out");
    expect(canceled).toBe(true);
  });
});
