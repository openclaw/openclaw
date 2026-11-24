import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { packageActivationRuntimeEntrypoint } from "./package-update-activation-runtime-assets.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const child = fileURLToPath(
  resolveRuntimeWorkerUrl({
    ...packageActivationRuntimeEntrypoint,
    sourceWorkerName: "package-update-release-switch.process.test-support",
    distWorkerPath: "infra/package-update-release-switch.process.test-support.js",
  }),
);

type ChildEvent = {
  cut?: string;
  boundary?: number;
  label?: string;
  status?: string;
  detail?: string;
  rollback?: { exitCode: number | null; error?: string | null };
};
export type KillSweepTools = "missing" | undefined;
export type KillSweepChildEnv = (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

/** Run one installation in a child on the prefix under `root`; `cut` says where it is killed. */
export async function runSwitch(
  root: string,
  cut: string,
  layout: "linked" | "plain" | "swap" | "journal",
  options: { tools?: KillSweepTools; verification?: "fails"; env?: KillSweepChildEnv } = {},
) {
  const packagePath = path.join(root, "prefix", "lib", "node_modules", "openclaw");
  let authority = "";
  if (layout === "journal") {
    // The child publishes under an executor that uses this test's private lease database.
    fs.mkdirSync(packagePath, { recursive: true });
    authority = JSON.stringify(
      await withUpdateCommandExecutor(randomUUID(), async (executor) =>
        captureUpdateCommandExecutorAuthority(await executor.enter(packagePath)),
      ),
    );
  }
  const proc = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(pathToFileURL(child)),
      cut,
      root,
      layout,
      options.tools ?? "",
      options.verification ?? "",
      authority,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env?.({ ...process.env, HOME: root, USERPROFILE: root }),
    },
  );
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
    proc.on("close", (_code, closeSignal) => resolve(closeSignal));
  });
  const events = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ChildEvent);
  // The child reports the cut it reached last, then dies there or exits.
  expect({ signal, stderr, cut: events.at(-1)?.cut }).toMatchObject({
    signal: cut === "complete" ? null : "SIGKILL",
    cut,
  });
  const prefix = path.join(root, "prefix");
  const globalRoot = path.join(prefix, "lib", "node_modules");
  return {
    events,
    root,
    prefix,
    slot: path.join(globalRoot, "openclaw"),
    globalRoot,
    previous: path.join(prefix, "releases", "r1", "lib", "node_modules", "openclaw"),
    candidate: fs.readFileSync(path.join(root, "candidate"), "utf8"),
    temporaryLinks: () =>
      fs.readdirSync(globalRoot).filter((name) => name.startsWith(".openclaw.release-link-")),
  };
}

export const packageVersion = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

/**
 * Replace a plain package directory once to the end, then once per boundary of
 * that run with the updater killed there. `installed` is the version the
 * package path serves afterwards, or null when it serves nothing.
 */
export async function killAtEveryBoundary(
  base: string,
  layout: "plain" | "swap" | "journal",
  tools?: KillSweepTools,
  env?: KillSweepChildEnv,
) {
  const complete = await runSwitch(path.join(base, "complete"), "complete", layout, { tools, env });
  const labels = complete.events.flatMap((event) => event.label ?? []);
  const kill = async (label: string, index: number) => {
    const root = path.join(base, `killed-${index + 1}`);
    const state = await runSwitch(root, `boundary:${index + 1}`, layout, { tools, env });
    let installed: string | null = null;
    try {
      installed = packageVersion(state.slot);
    } catch {
      // The package path resolves to no package.
    }
    return { label, state, installed };
  };
  // Journaled runs share one lease database, whose file lock refuses a crowd.
  const killed: Array<Awaited<ReturnType<typeof kill>>> = [];
  if (layout === "journal") {
    for (const [index, label] of labels.entries()) {
      killed.push(await kill(label, index));
    }
  } else {
    killed.push(...(await Promise.all(labels.map(kill))));
  }
  // Every killed run died right after the boundary the completed run names at that position.
  expect(killed.map((run) => run.state.events.at(-2)?.label)).toEqual(labels);
  expect(complete.events.at(-1)?.status).toBe("committed");
  return { labels, killed, complete, detail: complete.events.at(-1)?.detail ?? "" };
}
