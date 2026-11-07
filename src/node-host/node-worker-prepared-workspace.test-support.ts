import fsp from "node:fs/promises";
import path from "node:path";
import { captureWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import * as processExec from "../process/exec.js";
import type { NodeWorkerPreparedWorkspaceBinding } from "../worker/node-workspace-prepared-protocol.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

export const preparationKey = "a".repeat(64);
export const cacheKey = "c".repeat(64);
export const binding: NodeWorkerPreparedWorkspaceBinding = {
  action: "bind",
  gatewayNamespace: "gateway-prepared",
  environmentId: "environment-prepared",
  preparationKey,
  cacheKey,
  sessionId: "session-prepared",
  sessionKey: "agent:main:prepared",
  ownerEpoch: 2,
};

export async function createPreparedWorkspaceFixture(
  root: string,
  setupWrites = false,
  setupPath = "source.txt",
) {
  const ownerRoot = path.join(
    root,
    ".openclaw-worker",
    "prepared",
    binding.gatewayNamespace,
    cacheKey,
  );
  const workspaceDir = path.join(ownerRoot, "workspace");
  const homeDir = path.join(ownerRoot, "home");
  // Match the private owner root created by project preparation, independent of host umask.
  await fsp.mkdir(ownerRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    fsp.mkdir(workspaceDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(homeDir, { recursive: true, mode: 0o700 }),
  ]);
  const git = async (...args: string[]) =>
    (
      await processExec.runExec("git", ["-C", workspaceDir, ...args], { timeoutMs: 10_000 })
    ).stdout.trim();
  await git("init", "--quiet");
  await fsp.writeFile(path.join(workspaceDir, ".gitignore"), ".venv/\n");
  await fsp.writeFile(path.join(workspaceDir, "source.txt"), "prepared source\n");
  await fsp.mkdir(path.join(workspaceDir, "tracked-dir"));
  await fsp.writeFile(path.join(workspaceDir, "tracked-dir", "input.txt"), "pristine child\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Prepared Test",
    "-c",
    "user.email=prepared@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "prepared source",
  );
  const baseCommit = await git("rev-parse", "HEAD");
  const { manifestRef: sourceManifestRef, manifest } = await captureWorkspaceManifest({
    root: workspaceDir,
    baseCommit,
  });
  const manifests = path.join(homeDir, ".openclaw-worker", "manifests");
  await fsp.mkdir(manifests, { recursive: true });
  await fsp.writeFile(
    path.join(manifests, `${sourceManifestRef.slice(7)}.json`),
    serializeWorkerWorkspaceManifest(manifest),
  );
  // Setup output appears after the pristine source manifest, as in project preparation.
  await fsp.mkdir(path.join(workspaceDir, ".venv"));
  await fsp.writeFile(
    path.join(workspaceDir, ".venv", "absolute-path"),
    `${workspaceDir}\n${homeDir}`,
  );
  if (setupWrites) {
    await fsp.writeFile(path.join(workspaceDir, setupPath), "setup changed source\n");
    await fsp.writeFile(path.join(workspaceDir, "setup-output.txt"), "eligible setup output\n");
  }
  const prepared = await captureWorkspaceManifest({ root: workspaceDir, baseCommit });
  await fsp.writeFile(
    path.join(manifests, `${prepared.manifestRef.slice(7)}.json`),
    serializeWorkerWorkspaceManifest(prepared.manifest),
  );
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const options = { env, ephemeral: true };
  const runtime = new NodeWorkerWorkspaceRuntime(options);
  const registration = {
    action: "register" as const,
    gatewayNamespace: binding.gatewayNamespace,
    environmentId: binding.environmentId,
    preparationKey,
    cacheKey,
    workspaceDir,
    homeDir,
    sourceManifestRef,
    preparedManifestRef: prepared.manifestRef,
  };
  const request = {
    workspaceDir,
    environmentId: binding.environmentId,
    sessionId: binding.sessionId,
    sessionKey: binding.sessionKey,
    ownerEpoch: binding.ownerEpoch,
  };
  const command = {
    gatewayNamespace: binding.gatewayNamespace,
    environmentId: binding.environmentId,
    sessionId: binding.sessionId,
    sessionKey: binding.sessionKey,
    preparationKey,
    generation: binding.ownerEpoch,
    argv: ["node", "-e", "process.stdout.write(process.cwd() + '\\n' + process.env.HOME)"],
  };
  return {
    root,
    ownerRoot,
    workspaceDir,
    homeDir,
    env,
    options,
    runtime,
    registration,
    request,
    command,
    baseCommit,
  };
}
