import path from "node:path";
import { readArchiveEntry } from "../infra/archive.js";
import { packNpmSpecToArchive, withInstallWorkspace } from "../infra/install-source-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { fetchNpmTagVersion, resolveNpmChannelTag } from "../infra/update-check.js";
import {
  canResolveRegistryVersionForPackageTarget,
  resolveGlobalInstallSpec,
} from "../infra/update-global.js";
import { fetchGitUpdateTarget, selectChannelTag } from "../infra/update-runner-git-target.js";
import type { RunStepOptions } from "../infra/update-runner-types.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { runCommandWithTimeout } from "../process/exec.js";

export type UpdateTarget =
  | { kind: "git"; checkout: string; sha: string; version: string }
  | { kind: "package"; spec: string; version: string; engines?: { node?: string } };

/** Resolve once; preparation and engine checks consume the same pinned target. */
export async function resolveTarget(params: {
  kind: UpdateTarget["kind"];
  channel: UpdateChannel;
  checkout?: string;
  tag?: string;
  sha?: string;
  timeoutMs?: number;
}): Promise<UpdateTarget> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  if (params.kind === "package") {
    if (params.sha) {
      throw new Error("A Git SHA requires a Git install.");
    }
    if (params.tag && !canResolveRegistryVersionForPackageTarget(params.tag)) {
      let spec = resolveGlobalInstallSpec({ packageName: "openclaw", tag: params.tag });
      // Packing uses a private workspace; local artifact paths belong to the invoking cwd.
      if (spec.startsWith("file:")) {
        spec = `file:${path.resolve(spec.slice(5))}`;
      } else if (spec.startsWith(".") || path.isAbsolute(spec)) {
        spec = path.resolve(spec);
      }
      return await withInstallWorkspace("openclaw-update-target-", async (cwd) => {
        const packed = await packNpmSpecToArchive({
          spec,
          cwd,
          timeoutMs,
          workTimeoutMs: timeoutMs,
        });
        if (!packed.ok) {
          throw new Error(packed.error);
        }
        if (packed.metadata.name !== "openclaw" || !packed.metadata.version) {
          throw new Error("The update artifact must contain the openclaw package and a version.");
        }
        const manifest: { engines?: { node?: string } } = JSON.parse(
          (
            await readArchiveEntry(packed.archivePath, "package/package.json", {
              maxBytes: 1024 * 1024,
            })
          ).toString("utf8"),
        );
        return {
          kind: "package",
          spec,
          version: packed.metadata.version,
          engines: manifest.engines ?? {},
        };
      });
    }
    const selected = params.tag
      ? await fetchNpmTagVersion({ tag: params.tag, timeoutMs })
      : await resolveNpmChannelTag({ channel: params.channel, timeoutMs });
    if (!selected.version) {
      throw new Error(selected.error ?? "No release is available for this channel.");
    }
    return { kind: "package", spec: `openclaw@${selected.version}`, version: selected.version };
  }
  if (!params.checkout) {
    throw new Error("Git updates require a checkout.");
  }
  if (params.channel === "extended-stable") {
    throw new Error("unsupported_git_channel");
  }
  const checkout = params.checkout;
  const git = async (...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", checkout, ...args], {
      timeoutMs,
      killProcessTree: true,
    });
    if (result.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.slice(-8192)}`);
    }
    return result.stdout.trim();
  };
  const steps: UpdateStepResult[] = [];
  const step = (name: string, argv: string[], cwd: string): RunStepOptions => ({
    name,
    argv,
    cwd,
    timeoutMs,
    runCommand: runCommandWithTimeout,
    stepIndex: steps.length,
    totalSteps: 1,
    results: steps,
  });
  const explicit = params.sha ?? params.tag;
  const fetched = await fetchGitUpdateTarget({
    root: checkout,
    channel: params.sha ? "dev" : params.tag ? "stable" : params.channel,
    ...(params.sha ? { devTarget: { mode: "detached" as const, ref: params.sha } } : {}),
    name: "fetch",
    step,
    workStep: step,
    steps,
  });
  if (!fetched.ok) {
    throw new Error(steps.at(-1)?.stderrTail || fetched.reason || "Git target fetch failed.");
  }
  const ref =
    explicit ??
    (params.channel === "dev"
      ? (fetched.devSource?.revision ?? fetched.devSource?.mergeRef)
      : selectChannelTag((await git("tag", "--list", "v*")).split("\n"), params.channel));
  if (!ref) {
    throw new Error("No Git release is available for this channel.");
  }
  const sha = await git("rev-parse", "--verify", `${ref}^{commit}`);
  const manifest: { version: string } = JSON.parse(await git("show", `${sha}:package.json`));
  return { kind: "git", checkout, sha, version: manifest.version };
}
