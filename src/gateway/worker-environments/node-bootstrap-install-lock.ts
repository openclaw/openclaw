import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveNpmCommand } from "../../infra/npm-command.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";
import type { TransferArtifact } from "./artifact-transfer-service.js";

const log = createSubsystemLogger("gateway/worker-environments");

/** A fresh project keeps npm's optional platform variants independent of the Gateway's OS. */
export async function prepareNodeBootstrapInstallLock(
  artifact: TransferArtifact,
): Promise<TransferArtifact | undefined> {
  const root = path.dirname(artifact.tarballPath);
  const project = path.join(root, "install-project");
  try {
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ private: true, dependencies: { openclaw: "file:../node-runtime.tgz" } }),
    );
    // Never lend Gateway credentials, npmrc policy, or platform overrides to this subprocess.
    const env = {
      ...Object.fromEntries(
        ["PATH", "Path", "SystemRoot", "COMSPEC", "PATHEXT"].map((key) => [key, process.env[key]]),
      ),
      HOME: project,
      USERPROFILE: project,
      npm_config_cache: path.join(project, "cache"),
      npm_config_userconfig: path.join(project, ".npmrc"),
    };
    await fs.writeFile(env.npm_config_userconfig, "");
    const result = await runCommandWithTimeout(
      resolveNpmCommand([
        "install",
        "--package-lock-only",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]),
      { cwd: project, baseEnv: env, timeoutMs: 120_000, maxOutputBytes: 64 * 1024 },
    );
    if (result.code !== 0 || result.termination !== "exit") {
      const code = /npm (?:error|ERR!) code ([A-Z0-9_]+)/u.exec(result.stderr)?.[1];
      throw new Error(`${code ?? result.termination} (exit ${result.code ?? "unknown"})`);
    }
    const contents = await fs.readFile(path.join(project, "package-lock.json"));
    if (contents.length === 0 || contents.length > MAX_WORKER_BUNDLE_ARCHIVE_BYTES) {
      throw new Error("Generated runtime lock is empty or exceeds the transfer limit");
    }
    const tarballPath = path.join(root, "package-lock.json");
    await fs.rename(path.join(project, "package-lock.json"), tarballPath);
    return {
      tarballPath,
      tarballBytes: contents.length,
      tarballSha256: createHash("sha256").update(contents).digest("hex"),
    };
  } catch (error) {
    // The provider caches this non-outcome along with the archive; workers retain unlocked install.
    log.warn(
      `Cloud worker runtime lock generation failed; using unlocked installs: ${String(error)}`,
    );
    return undefined;
  } finally {
    await fs.rm(project, { recursive: true, force: true }).catch(() => undefined);
  }
}
