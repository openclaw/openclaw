import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareInstalledPackage } from "../../scripts/lib/gateway-bench-installed-package.ts";
import { verifyPackageMember } from "../../scripts/lib/windows-repair-package.mts";
import { isMainModule } from "../infra/is-main.js";
import { packageRoot, prefix, readInput } from "./schtasks.installed-package.test-support.js";

const reviewedFixturePaths = new Set([
  "src/daemon/schtasks.integration-observation.test-support.ts",
  "src/daemon/schtasks.integration.e2e.test.ts",
  "src/daemon/schtasks.integration-xml.test.ts",
  "src/daemon/schtasks.installed-diagnostics.test-support.ts",
  "src/daemon/schtasks.installed-command.test-support.ts",
  "src/daemon/schtasks.installed-authority.test-support.ts",
  "src/daemon/schtasks.installed.integration.test-support.ts",
  "src/daemon/schtasks.installed-startup.test-support.ts",
  "src/daemon/schtasks.installed-fingerprint-observer.test-support.mts",
  "src/daemon/schtasks.installed-fingerprint-observer.test.ts",
  "src/config/sessions/session-sharing-store.test.ts",
  ".github/workflows/windows-testbox-probe.yml",
  "test/helpers/gateway/config-rpc-gateway.ts",
  "src/daemon/schtasks.installed-powershell-context.test-support.mts",
  "src/daemon/schtasks.installed-package.test-support.ts",
  "src/daemon/schtasks.installed-package.test.ts",
]);

/** The source observer may differ from the package only in these reviewed proof fixtures. */
export function verifyInstalledFingerprintSource(params: {
  sourceSha: string;
  toolingSha: string;
  cwd?: string;
}): string[] {
  assert.match(params.sourceSha, /^[0-9a-f]{40}$/u);
  assert.match(params.toolingSha, /^[0-9a-f]{40}$/u);
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-optional-locks", ...args], {
      cwd: params.cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
  assert.equal(git("rev-parse", "HEAD").trim(), params.toolingSha);
  git("diff", "--quiet", "HEAD", "--");
  git("cat-file", "-e", `${params.sourceSha}^{commit}`);
  const changed = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-only",
    "-z",
    params.sourceSha,
    params.toolingSha,
    "--",
  )
    .split("\0")
    .filter(Boolean);
  for (const filename of changed) {
    assert.ok(
      reviewedFixturePaths.has(filename),
      `Candidate source differs outside reviewed proof fixtures: ${filename}`,
    );
  }
  return changed;
}

if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
  const inputPath = process.argv[2];
  assert.ok(inputPath);
  const input = await readInput(inputPath);
  const head = execFileSync("git", ["--no-optional-locks", "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.equal(head, input.toolingSha);
  execFileSync("git", ["--no-optional-locks", "diff", "--quiet", "HEAD", "--"]);
  const selectedPrefix = prefix(input, "2026.9.4");
  await prepareInstalledPackage({ ...input, installRoot: selectedPrefix });
  // A fresh tooling checkout is shallow; acquire only the already-authenticated candidate commit.
  const candidateCommit = spawnSync("git", ["cat-file", "-e", `${input.sourceSha}^{commit}`], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    stdio: "ignore",
  });
  if (candidateCommit.error) {
    throw candidateCommit.error;
  }
  if (candidateCommit.status !== 0) {
    execFileSync(
      "git",
      [
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--depth=1",
        "https://github.com/openclaw/openclaw.git",
        input.sourceSha,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: "pipe" },
    );
  }
  const toolingChanges = verifyInstalledFingerprintSource({
    sourceSha: input.sourceSha,
    toolingSha: head,
  });
  const root = packageRoot(selectedPrefix);
  const oldRoot = packageRoot(prefix(input, "2026.9.4-peer"));
  const published = input.published.find((receipt) => receipt.version === "2026.9.4");
  assert.ok(published);
  const members = [
    "service-BzKA2MoQ.mjs",
    "service-CtaCtaGY.mjs",
    "update-command-service-maintenance-CT7mpZhp.mjs",
    "update-command-service-maintenance-Bc76z_xW.mjs",
    "schtasks-CELg2OWo.mjs",
    "stable-stringify-C8X7niaI.mjs",
    "update-command-service-plan-CPLT9k8F.mjs",
    "build-info.json",
  ];
  const evidence = [];
  for (const member of members) {
    evidence.push(
      await verifyPackageMember(oldRoot, published.tarball, path.join(oldRoot, "dist", member)),
    );
  }
  assert.equal(
    evidence[0]?.sha256,
    "7ebd13814abefa7561f2e559d0a23449ff2e8cc0b1a76d0b019a0a4718d102f7",
  );
  assert.equal(
    evidence[2]?.sha256,
    "456fbdf78533b773edc8cd84036125a975a65b4b62015deab913f029b0a743d1",
  );
  // These exact published facades have named exports; the generic ambiguity guard stays unchanged.
  const oldService: Pick<
    typeof import("./service.js"),
    "readGatewayServiceState" | "resolveGatewayService"
  > = await import(pathToFileURL(path.join(oldRoot, "dist", members[0]!)).href);
  const oldMaintenance: Pick<
    typeof import("../cli/update-cli/update-command-service-maintenance.js"),
    "revalidateManagedGatewayServiceAfterUpdate"
  > = await import(pathToFileURL(path.join(oldRoot, "dist", members[2]!)).href);
  assert.equal(typeof oldService.readGatewayServiceState, "function");
  assert.equal(typeof oldService.resolveGatewayService, "function");
  assert.equal(typeof oldMaintenance.revalidateManagedGatewayServiceAfterUpdate, "function");
  const candidateService = await import("./service.js");
  const candidateMaintenance =
    await import("../cli/update-cli/update-command-service-maintenance.js");
  const { resolveStartupEntryPaths } = await import("./schtasks-layout.js");
  const args = { env: process.env, requireEffective: true, requireLoadedCommand: true };
  const oldState = await oldService.readGatewayServiceState(
    oldService.resolveGatewayService(),
    args,
  );
  const candidateState = await candidateService.readGatewayServiceState(
    candidateService.resolveGatewayService(),
    args,
  );
  for (const state of [oldState, candidateState]) {
    assert.equal(state.installed, true);
    assert.equal(state.loadState.status, "loaded");
    assert.equal(state.running, false);
    assert.equal(state.runtime?.status, "stopped");
    assert.equal(state.runtime?.pid, undefined);
    assert.equal(state.definitionMutationCapability, undefined);
    assert.ok(state.command);
  }
  assert.ok(oldState.command && candidateState.command);
  assert.equal(oldState.command.startupEntryPaths, undefined);
  const { startupEntryPaths, ...candidateCommand } = candidateState.command;
  assert.ok(startupEntryPaths && startupEntryPaths.length === 2);
  assert.deepEqual(startupEntryPaths.toSorted(), resolveStartupEntryPaths(process.env).toSorted());
  assert.deepEqual(candidateCommand, oldState.command);
  const oldVerdict = await oldMaintenance.revalidateManagedGatewayServiceAfterUpdate({
    root,
    state: oldState,
  });
  assert.ok(oldVerdict.kind === "owned");
  assert.equal(oldVerdict.refreshDefinition, true);
  const candidateVerdict = await candidateMaintenance.revalidateManagedGatewayServiceAfterUpdate({
    root,
    state: candidateState,
    preManagedServiceStop: { serviceEnv: oldState.env, serviceUpdateVerdict: oldVerdict },
  });
  assert.ok(candidateVerdict.kind === "owned");
  assert.equal(candidateVerdict.refreshDefinition, true);
  // Writable revalidation can accept drift; equality independently proves the legacy fingerprint contract.
  assert.equal(candidateVerdict.fingerprint, oldVerdict.fingerprint);
  console.log(
    JSON.stringify({
      scope:
        "unchanged published 2026.9.4 helper × exact candidate source owner on real stopped Startup definition",
      sourceSha: input.sourceSha,
      toolingSha: head,
      toolingChanges,
      publishedTarballSha256: published.sha256,
      evidence,
      oldFingerprint: oldVerdict.fingerprint,
      candidateFingerprint: candidateVerdict.fingerprint,
      selectedStartupEntries: startupEntryPaths,
      refreshDefinition: true,
      packagedCandidateFacadeProof: false,
      protectedAuthorityProof: false,
      fullUpgradeProof: false,
    }),
  );
}
