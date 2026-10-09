import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import {
  hashFile,
  hashInstall,
  installedPackageSchema,
  prepareInstalledPackage,
} from "../../scripts/lib/gateway-bench-installed-package.ts";
import { hasErrnoCode } from "../infra/errno.js";
import { isMainModule } from "../infra/is-main.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../infra/process-env.js";
import { run, type CommandRecord } from "./schtasks.installed-command.test-support.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";

export const installedStatusSchema = z.object({
  service: z.object({
    loaded: z.literal(true),
    runtime: z.object({ status: z.literal("running"), pid: z.number().int().positive() }),
    command: z.object({ programArguments: z.array(z.string()) }),
  }),
  rpc: z.object({
    ok: z.literal(true),
    url: z.string(),
    server: z.object({ version: z.string(), buildId: z.string().min(1) }),
  }),
  gateway: z.object({ port: z.number().int().positive(), version: z.string() }),
});
export async function readInstalledBuildIdentity(installRoot: string, expectedVersion: string) {
  const filename = path.join(packageRoot(installRoot), "dist", "build-info.json");
  return z
    .object({ version: z.literal(expectedVersion), buildId: z.string().min(1) })
    .parse(JSON.parse(await fs.readFile(filename, "utf8")));
}
export function describeFailure(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return {
    name: error.name,
    message: error.message,
    ...(error instanceof AggregateError ? { errors: error.errors.map(describeFailure) } : {}),
  };
}
export function parseInstalledPreview(output: string, installRoot: string) {
  const value = z
    .object({
      dryRun: z.literal(true),
      root: z.string(),
      installKind: z.literal("package"),
      updateInstallKind: z.literal("package"),
      mode: z.literal("npm"),
      notes: z.array(z.string()),
    })
    .parse(JSON.parse(output));
  samePath(value.root, packageRoot(installRoot));
  return value;
}

// Registry provenance is distinct from the candidate's Package Acceptance artifact.
const publishedWindowsBaselines = [
  {
    version: "2026.9.3",
    commit: "1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7",
    sha256: "d1c63366833f8ae4a6ab4f3b60b1aa84ca82d03dba13d3d3eba989aa159e2449",
    integrity:
      "sha512-CzDHMeHdnjlIZ76ZyBb1lvLO4H/yBIMYXupFGGBN87x0853y3hg5nLAnKfxSKqLzqhbUKqy9ebDRAWWV4t8aew==",
  },
  {
    version: "2026.9.4",
    commit: "3a9d69db306cd7f081e06254cb89c4bcc14a7107",
    sha256: "4f1f656770461d4677dea755b1899cba12b912b06798c89a59e2f0c18688b761",
    integrity:
      "sha512-lTQpEEe1Xm3u2PCHaPEr+vP8paGk1vLdHuzdItsNToaLI6hAqRVvgJYg+GxukJhETJp4tPy/S1Gftl4KuB8n7A==",
  },
] as const;
const registryReceiptSchema = z.object({
  source: z.literal("npm-registry"),
  version: z.string(),
  commit: z.string(),
  tarball: z.string(),
  metadata: z.string(),
  sha256: z.string(),
  integrity: z.string(),
});
const inputSchema = installedPackageSchema.extend({
  published: z.array(registryReceiptSchema).length(2),
});
type Input = z.infer<typeof inputSchema>;
export const keys = ["fresh", "2026.9.3", "2026.9.4"] as const;
// Aggregate serial fixture phases, including the complete published updater's stage sequence.
const installedCellBodyTimeoutMs = {
  fresh: 360_000,
  "2026.9.3": 1_080_000,
  "2026.9.4": 1_440_000,
} satisfies Record<(typeof keys)[number], number>;
export function createInstalledProgressRecorder(params: {
  input: Input;
  key: (typeof keys)[number];
  rootDir: string;
  proofPath: string;
  commands: CommandRecord[];
  observations: Record<string, unknown>;
}) {
  const { input, key, rootDir, proofPath, commands, observations } = params;
  const progressStarted = performance.now();
  let progressFailure: Error | undefined;
  return async (phase: string, error?: Error) => {
    progressFailure = error ?? progressFailure;
    // Persist settled commands and the original error before native cleanup can be interrupted.
    await fs.writeFile(path.join(rootDir, "commands.json"), JSON.stringify(commands, null, 2));
    await fs.writeFile(
      proofPath,
      JSON.stringify(
        {
          result: progressFailure ? "failed" : "in-progress",
          head: input.toolingSha,
          candidate: input.candidate,
          published: input.published,
          cell: key,
          cells: [
            {
              key,
              phase,
              commands,
              observations,
              failure: progressFailure && describeFailure(progressFailure),
            },
          ],
          cleanupComplete: false,
          elapsedMs: performance.now() - progressStarted,
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    // Only fixed labels reach stdout; command arguments and diagnostics stay in the proof.
    let outputPhase = "fixture";
    if (phase.startsWith("command:")) {
      outputPhase = "command-result";
    } else if (phase === "published-update:completed-step") {
      outputPhase = "update-step-completed";
    } else if (phase.startsWith("disabled-discovery:")) {
      outputPhase = "disabled-discovery";
    } else if (phase.endsWith(":waiting")) {
      outputPhase = "readiness-wait";
    } else if (phase.endsWith(":ready")) {
      outputPhase = "readiness-ready";
    } else if (phase === "selected-status-verified") {
      outputPhase = "selected-status-verified";
    } else if (phase.startsWith("authority:")) {
      outputPhase = "authority-checkpoint";
    } else if (
      phase.startsWith("task-sibling-refusal:") ||
      phase.startsWith("startup-alias-refusal:")
    ) {
      outputPhase = "sibling-refusal-checkpoint";
    } else if (phase === "fingerprint-result") {
      outputPhase = "fingerprint-result";
    } else if (phase.endsWith(":hash-verified")) {
      outputPhase = "install-hash-verified";
    } else if (phase.endsWith("cleanup:command-result")) {
      outputPhase = "cleanup-command-result";
    } else if (phase === "before-native-cleanup") {
      outputPhase = "native-cleanup";
    }
    process.stdout.write(
      `[schtasks-installed] ${JSON.stringify({
        cell: key,
        phase: outputPhase,
        elapsedMs: Math.round(performance.now() - progressStarted),
        outcome: progressFailure ? "failed" : "in-progress",
      })}\n`,
    );
  };
}

export function resolveInstalledCellBodyTimeoutMs(cell: string | undefined) {
  return installedCellBodyTimeoutMs[z.enum(keys).parse(cell)];
}
const preparedCellSchema = z.object({
  cell: z.enum(keys),
  inputSha256: z.string(),
  preparationRoot: z.string(),
  cells: z.array(
    z.object({
      key: z.string(),
      installRoot: z.string(),
      installed: z.object({ sha256: z.string(), files: z.number() }),
    }),
  ),
});
export function cellEvidence(inputPath: string, key: string) {
  return path.join(path.dirname(path.resolve(inputPath)), "cells", key);
}
export async function readPreparedCell(
  inputPath: string,
  input: Input,
  key: (typeof keys)[number],
) {
  const prepared = preparedCellSchema.parse(
    JSON.parse(await fs.readFile(path.join(cellEvidence(inputPath, key), "prepared.json"), "utf8")),
  );
  assert.equal(prepared.cell, key);
  assert.equal(prepared.inputSha256, await hashFile(inputPath));
  assert.deepEqual(
    prepared.cells.map((cell) => cell.key),
    key === "fresh" ? [key] : [key, `${key}-peer`],
  );
  for (const cell of prepared.cells) {
    samePath(cell.installRoot, prefix(input, cell.key));
  }
  samePath(prepared.preparationRoot, path.join(input.stateRoot, `${key}-preparation`));
  return prepared;
}
export async function verifyPreparedInstall(
  prepared: Awaited<ReturnType<typeof readPreparedCell>>,
  key: string,
  installRoot: string,
) {
  const initial = prepared.cells.find((cell) => cell.key === key);
  assert.ok(initial);
  samePath(initial.installRoot, installRoot);
  assert.deepEqual(
    await hashInstall(installRoot),
    initial.installed,
    "Prepared package changed before its cell",
  );
  return initial;
}
type OwnedUsage = {
  logicalBytes: number;
  reportedAllocatedBytes: number;
  files: number;
  links: number;
  nonemptyFilesReportingZeroBlocks: number;
  vanishedEntries: number;
};
async function measureOwnedDirectory(root: string): Promise<OwnedUsage | null> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (entries === null) {
    return null;
  }
  const total: OwnedUsage = {
    logicalBytes: 0,
    reportedAllocatedBytes: 0,
    files: 0,
    links: 0,
    nonemptyFilesReportingZeroBlocks: 0,
    vanishedEntries: 0,
  };
  for (const item of entries) {
    const full = path.join(root, item.name);
    const stat = await fs.lstat(full).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    });
    if (stat === null) {
      total.vanishedEntries += 1;
      continue;
    }
    if (stat.isSymbolicLink()) {
      total.links += 1;
      continue;
    }
    if (stat.isDirectory()) {
      const nested = await measureOwnedDirectory(full);
      if (nested) {
        total.logicalBytes += nested.logicalBytes;
        total.reportedAllocatedBytes += nested.reportedAllocatedBytes;
        total.files += nested.files;
        total.links += nested.links;
        total.nonemptyFilesReportingZeroBlocks += nested.nonemptyFilesReportingZeroBlocks;
        total.vanishedEntries += nested.vanishedEntries;
      }
    } else if (stat.isFile()) {
      total.files += 1;
      total.logicalBytes += stat.size;
      total.reportedAllocatedBytes += stat.blocks * 512;
      if (stat.size > 0 && stat.blocks === 0) {
        total.nonemptyFilesReportingZeroBlocks += 1;
      }
    }
  }
  return total;
}
export async function recordCapacityBoundary(
  inputPath: string,
  input: Input,
  key: (typeof keys)[number],
  boundary: string,
) {
  const volume = await fs.statfs(path.dirname(input.installRoot));
  const homeVolume = await fs.statfs(os.userInfo().homedir);
  const prefixes = [];
  for (const item of await fs.readdir(input.installRoot, { withFileTypes: true })) {
    const pathname = path.join(input.installRoot, item.name);
    let usage: OwnedUsage | null = null;
    if (item.isDirectory() && !item.isSymbolicLink()) {
      usage = await measureOwnedDirectory(pathname);
    } else if (item.isFile()) {
      const stat = await fs.lstat(pathname).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      });
      if (stat?.isFile()) {
        usage = {
          logicalBytes: stat.size,
          reportedAllocatedBytes: stat.blocks * 512,
          files: 1,
          links: 0,
          nonemptyFilesReportingZeroBlocks: stat.size > 0 && stat.blocks === 0 ? 1 : 0,
          vanishedEntries: 0,
        };
      }
    }
    prefixes.push({ name: item.name, usage });
  }
  const expectedProfileState = [];
  const id = process.env.CI_WINDOWS_SCHTASKS_TEST_ID;
  assert.ok(id && /^[a-z0-9-]{1,48}$/u.test(id));
  for (const [index, previous] of keys.slice(0, keys.indexOf(key) + 1).entries()) {
    for (const role of previous === "fresh"
      ? ["selected", "non-gateway", "missing", "direct", "extra"]
      : ["selected", "peer"]) {
      const profile = `schtasks-int-${id}-${index}-${role}`;
      expectedProfileState.push({
        profile,
        usage: await measureOwnedDirectory(
          path.join(os.userInfo().homedir, `.openclaw-${profile}`),
        ),
      });
    }
  }
  const sample = {
    boundary,
    cell: key,
    availableBytes: volume.bavail * volume.bsize,
    freeBytes: volume.bfree * volume.bsize,
    totalBytes: volume.blocks * volume.bsize,
    profileHomeAvailableBytes: homeVolume.bavail * homeVolume.bsize,
    expectedProfileState,
    installAndStaging: prefixes,
    stateAndPreparation: await measureOwnedDirectory(input.stateRoot),
    scope:
      "observed lifecycle boundary only; transient peaks unknown; allocation is fs.Stats.blocks as reported by this Windows runtime",
  };
  await fs.appendFile(
    path.join(cellEvidence(inputPath, key), "capacity.jsonl"),
    `${JSON.stringify(sample)}\n`,
  );
  return sample;
}
export function requiredCellSpace(key: (typeof keys)[number]) {
  const gib = 1024 ** 3;
  // Planning allowances, not measurements or claimed upper bounds for package scripts.
  const forecast = {
    installedPrefixes: (key === "fresh" ? 6 : 12) * gib,
    preparationScratch: 4 * gib,
    upgradeStaging: (key === "fresh" ? 0 : 6) * gib,
    runtimeNpmCache: (key === "fresh" ? 0 : 4) * gib,
    retainedStateAndProof: gib,
    freeFloor: 2 * gib,
  };
  return { forecast, neededBytes: Object.values(forecast).reduce((sum, value) => sum + value, 0) };
}
export function prefix(input: Input, key: string) {
  return path.join(input.installRoot, key);
}
export function packageRoot(installRoot: string) {
  return path.join(installRoot, "node_modules", "openclaw");
}
export function entry(installRoot: string) {
  return path.join(packageRoot(installRoot), "openclaw.mjs");
}
export function samePath(actual: string, expected: string) {
  assert.equal(path.resolve(actual).toLowerCase(), path.resolve(expected).toLowerCase());
}
export function boundedEnv(root: string, installRoot: string): NodeJS.ProcessEnv {
  const native = resolveServiceManagerEnv();
  return mergeProcessEnv([
    native,
    {
      PATH: [
        path.dirname(process.execPath),
        installRoot,
        resolveEnvironmentValue(native, "PATH"),
      ].join(path.delimiter),
      HOME: os.userInfo().homedir,
      USERPROFILE: os.userInfo().homedir,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "local-appdata"),
      TEMP: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      TMPDIR: path.join(root, "tmp"),
      npm_config_prefix: installRoot,
      npm_config_cache: path.join(root, "npm-cache"),
      NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(root, "global-npmrc"),
      CI: "true",
      NO_COLOR: "1",
    },
  ]);
}
export async function readInput(inputPath: string) {
  const input = inputSchema.parse(JSON.parse(await fs.readFile(inputPath, "utf8")));
  assert.equal(process.platform, "win32");
  samePath(input.installRoot, path.join(path.dirname(input.stateRoot), "native-package-installed"));
  assert.equal(process.version, input.runtime.version);
  assert.equal(await hashFile(process.execPath), input.runtime.sha256);
  assert.equal(await hashFile(input.tarball), input.candidate.sha256);
  for (const [index, pinned] of publishedWindowsBaselines.entries()) {
    const receipt = input.published[index];
    assert.ok(receipt);
    for (const field of ["version", "commit", "sha256", "integrity"] as const) {
      assert.equal(receipt[field], pinned[field]);
    }
    const metadata = JSON.parse(await fs.readFile(receipt.metadata, "utf8"));
    assert.equal(metadata.name, "openclaw");
    assert.equal(metadata.version, pinned.version);
    assert.equal(
      metadata.dist.tarball,
      `https://registry.npmjs.org/openclaw/-/openclaw-${pinned.version}.tgz`,
    );
    assert.equal(metadata.dist.integrity, pinned.integrity);
    assert.equal(await hashFile(receipt.tarball), pinned.sha256);
    assert.equal(
      `sha512-${Buffer.from(await hashFile(receipt.tarball, "sha512"), "hex").toString("base64")}`,
      pinned.integrity,
    );
  }
  return input;
}
async function verifyPackage(installRoot: string, version: string, commit: string) {
  const pkg = JSON.parse(
    await fs.readFile(path.join(packageRoot(installRoot), "package.json"), "utf8"),
  );
  const build = JSON.parse(
    await fs.readFile(path.join(packageRoot(installRoot), "dist", "build-info.json"), "utf8"),
  );
  assert.equal(pkg.name, "openclaw");
  assert.equal(pkg.version, version);
  assert.equal(build.commit, commit);
  return hashInstall(installRoot);
}

// Preparation is a separate existing-job step: no Scheduler mutation or product CLI here.
async function prepareInstalledLifecycle(inputPath: string) {
  const key = z.enum(keys).parse(process.env.CI_WINDOWS_SCHTASKS_INSTALLED_CELL);
  const input = await readInput(inputPath);
  if (key === "fresh") {
    await fs.mkdir(input.stateRoot);
    await fs.mkdir(input.installRoot);
  } else {
    samePath(await fs.realpath(input.stateRoot), input.stateRoot);
    samePath(await fs.realpath(input.installRoot), input.installRoot);
  }
  for (const previous of keys.slice(0, keys.indexOf(key))) {
    for (const name of previous === "fresh" ? [previous] : [previous, `${previous}-peer`]) {
      await assert.rejects(fs.lstat(prefix(input, name)), { code: "ENOENT" });
    }
    await assert.rejects(fs.lstat(path.join(input.stateRoot, `${previous}-preparation`)), {
      code: "ENOENT",
    });
    await assert.rejects(fs.lstat(path.join(input.stateRoot, previous, "npm-cache")), {
      code: "ENOENT",
    });
  }
  const evidence = cellEvidence(inputPath, key);
  await fs.mkdir(evidence, { recursive: true });
  const before = await recordCapacityBoundary(inputPath, input, key, "before-preparation");
  const space = requiredCellSpace(key);
  await fs.writeFile(
    path.join(evidence, "capacity-forecast.json"),
    JSON.stringify(
      {
        cell: key,
        basis: "finite conservative planning allowances; not measured capacity",
        ...space,
        observedAvailableBytes: before.availableBytes,
      },
      null,
      2,
    ),
  );
  assert.ok(
    before.availableBytes >= space.neededBytes,
    `Cell ${key} needs ${space.neededBytes} available bytes under its provisional forecast; observed ${before.availableBytes}; no install started`,
  );
  assert.ok(
    before.profileHomeAvailableBytes >=
      space.forecast.retainedStateAndProof + space.forecast.freeFloor,
    "Profile-home volume lacks the state/proof allowance and free-space floor; no install started",
  );
  const prep = path.join(input.stateRoot, `${key}-preparation`);
  await fs.mkdir(prep);
  for (const name of ["appdata", "local-appdata", "tmp", "npm-cache"]) {
    await fs.mkdir(path.join(prep, name));
  }
  await fs.writeFile(path.join(prep, "npmrc"), "");
  await fs.writeFile(path.join(prep, "global-npmrc"), "");
  const npm = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await fs.access(npm);
  const cells = [];
  const commands: CommandRecord[] = [];
  let failure: Error | undefined;
  try {
    for (const name of key === "fresh" ? [key] : [key, `${key}-peer`]) {
      const installRoot = prefix(input, name);
      await fs.mkdir(installRoot);
      const env = boundedEnv(prep, installRoot);
      const baseline = input.published.find((row) => row.version === key);
      const tarball = baseline?.tarball ?? input.tarball;
      await run(
        [
          npm,
          "install",
          "--global",
          "--prefix",
          installRoot,
          "--no-audit",
          "--no-fund",
          "--ignore-scripts=false",
          tarball,
        ],
        env,
        prep,
        commands,
      );
      samePath(
        (await run([npm, "root", "--global"], env, prep, commands)).trim(),
        path.join(installRoot, "node_modules"),
      );
      const installed = baseline
        ? await verifyPackage(installRoot, baseline.version, baseline.commit)
        : (await prepareInstalledPackage({ ...input, installRoot })).before;
      cells.push({ key: name, installRoot, installed });
      await recordCapacityBoundary(inputPath, input, key, `installed-${name}`);
    }
    await fs.writeFile(
      path.join(evidence, "prepared.json"),
      JSON.stringify(
        {
          cell: key,
          inputSha256: await hashFile(inputPath),
          preparationRoot: prep,
          cells,
          commands,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = toErrorObject(error, "Installed Scheduled Task fixture failed");
  }
  try {
    await fs.writeFile(
      path.join(evidence, "preparation-commands.json"),
      JSON.stringify(commands, null, 2),
    );
    await recordCapacityBoundary(inputPath, input, key, "preparation-finished");
  } catch (error) {
    failure = new AggregateError(
      failure ? [failure, error] : [error],
      "Preparation evidence failed",
    );
  }
  if (failure) {
    throw failure;
  }
}

// The workflow invokes this only after native cleanup and a successful immutable proof upload.
async function retireInstalledLifecycle(inputPath: string) {
  const key = z.enum(keys).parse(process.env.CI_WINDOWS_SCHTASKS_INSTALLED_CELL);
  const input = await readInput(inputPath);
  const prepared = await readPreparedCell(inputPath, input, key);
  const evidence = cellEvidence(inputPath, key);
  const proofPath = path.join(evidence, "proof.json");
  const proof = z
    .object({
      result: z.literal("pass"),
      cell: z.enum(keys),
      head: z.string(),
      candidate: z.object({ sha256: z.string() }),
      cells: z.array(z.object({ key: z.string(), result: z.literal("passed") })).length(1),
    })
    .parse(JSON.parse(await fs.readFile(proofPath, "utf8")));
  assert.equal(proof.cell, key);
  assert.equal(proof.cells[0]?.key, key);
  assert.equal(proof.head, input.toolingSha);
  assert.equal(proof.candidate.sha256, input.candidate.sha256);
  const artifactId = z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .parse(process.env.CI_WINDOWS_SCHTASKS_CELL_ARTIFACT_ID);
  const artifactDigest = z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .parse(process.env.CI_WINDOWS_SCHTASKS_CELL_ARTIFACT_DIGEST);
  assert.equal(process.env.CI_WINDOWS_SCHTASKS_CELL_CLEANUP, "success");
  const targets = [
    ...prepared.cells.map((cell) => cell.installRoot),
    prepared.preparationRoot,
    path.join(input.stateRoot, key, "npm-cache"),
  ];
  for (const target of targets) {
    const stat = await fs.lstat(target);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Disposable cell root must remain an owned directory",
    );
    samePath(await fs.realpath(target), target);
  }
  const proofSha256 = await hashFile(proofPath);
  await recordCapacityBoundary(inputPath, input, key, "before-retirement");
  const retired: string[] = [];
  let failure: Error | undefined;
  try {
    for (const target of targets) {
      const current = await fs.lstat(target);
      assert.ok(
        current.isDirectory() && !current.isSymbolicLink(),
        "Disposable cell root changed before retirement",
      );
      samePath(await fs.realpath(target), target);
      await fs.rm(target, { recursive: true });
      await assert.rejects(fs.lstat(target), { code: "ENOENT" });
      retired.push(target);
    }
  } catch (error) {
    failure = toErrorObject(error, "Installed Scheduled Task fixture failed");
  }
  try {
    await recordCapacityBoundary(inputPath, input, key, "after-retirement");
    await fs.writeFile(
      path.join(evidence, "retirement.json"),
      JSON.stringify(
        {
          result: retired.length === targets.length ? "pass" : "incomplete",
          cell: key,
          inputSha256: await hashFile(inputPath),
          proofSha256,
          artifactId,
          artifactDigest,
          targets,
          retired,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = new AggregateError(
      failure ? [failure, error] : [error],
      "Retirement evidence failed",
    );
  }
  if (failure) {
    throw failure;
  }
}

if (isMainModule({ currentFile: fileURLToPath(import.meta.url), env: {} })) {
  const [operation, inputPath] = process.argv.slice(2);
  assert.equal(process.argv.length, 4, "Expected prepare|retire and the installed input path");
  assert.ok(inputPath);
  if (operation === "prepare") {
    await prepareInstalledLifecycle(inputPath);
  } else if (operation === "retire") {
    await retireInstalledLifecycle(inputPath);
  } else {
    throw new Error("Expected the fixed prepare or retire operation");
  }
}
