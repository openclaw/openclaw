import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPackageReleases, listPackageReleases } from "./package-release-retention.js";
import { readPackageReleaseSlotSync } from "./package-release-slot-path.js";
import { capturePackageReleaseSlot, switchPackageReleaseLink } from "./package-release-slot.js";
import { stagePackageRelease } from "./package-update-release-switch.test-support.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { expectedPathExchangeRoute } from "./path-exchange.test-support.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";

const child = fileURLToPath(
  new URL("./package-update-release-switch.process.test-support.ts", import.meta.url),
);

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-crash-")));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type ChildEvent = { cut?: string; label?: string; status?: string; detail?: string };

/** Run one switch in a child on its own prefix; `cut` says where it is killed. */
async function runSwitch(
  cut: string,
  layout: "linked" | "plain",
  options: { root?: string; tools?: "missing" } = {},
) {
  const root = options.root ?? dir;
  const proc = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(pathToFileURL(child)), cut, root, layout, options.tools ?? ""],
    { stdio: ["ignore", "pipe", "pipe"] },
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
    prefix,
    slot: path.join(globalRoot, "openclaw"),
    globalRoot,
    previous: path.join(prefix, "releases", "r1", "lib", "node_modules", "openclaw"),
    candidate: fs.readFileSync(path.join(root, "candidate"), "utf8"),
    temporaryLinks: () =>
      fs.readdirSync(globalRoot).filter((name) => name.startsWith(".openclaw.release-link-")),
  };
}

const version = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

/**
 * Switch a plain package directory to a new release once to the end, then once
 * per boundary of that run with the updater killed there. `installed` is the
 * version the package path serves afterwards, or null when it serves nothing.
 */
async function killAtEveryBoundary(tools?: "missing") {
  const complete = await runSwitch("complete", "plain", {
    root: path.join(dir, "complete"),
    tools,
  });
  const labels = complete.events.flatMap((event) => event.label ?? []);
  const killed = await Promise.all(
    labels.map(async (label, index) => {
      const state = await runSwitch(`boundary:${index + 1}`, "plain", {
        root: path.join(dir, `killed-${index + 1}`),
        tools,
      });
      let installed: string | null = null;
      try {
        installed = version(state.slot);
      } catch {
        // The package path resolves to no package.
      }
      return { label, state, installed };
    }),
  );
  // Every killed run died right after the boundary the completed run names at that position.
  expect(killed.map((run) => run.state.events.at(-2)?.label)).toEqual(labels);
  // The completed run leaves the old tree as a release behind the switched link.
  const retained = fs
    .readdirSync(path.join(complete.prefix, "releases"))
    .filter((id) => id.startsWith("2026.11.3-"))
    .map((id) => path.join(complete.prefix, "releases", id, "lib", "node_modules", "openclaw"));
  expect(complete.events.at(-1)?.status).toBe("committed");
  expect(readPackageReleaseSlotSync(complete.slot)?.releaseRoot).toBe(complete.candidate);
  expect(retained.map(version)).toEqual(["2026.11.3"]);
  expect(fs.readdirSync(complete.globalRoot)).toEqual(["openclaw"]);
  return { labels, killed, detail: complete.events.at(-1)?.detail ?? "" };
}

describe.skipIf(process.platform === "win32")("release switch killed by SIGKILL", () => {
  it("before the temporary link: the old release stays selected and nothing is pending", async () => {
    const state = await runSwitch("before-temporary-link", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.previous);
    expect(state.temporaryLinks()).toEqual([]);
    // The unselected candidate is left for collection, complete and untouched.
    expect(version(state.candidate)).toBe("2026.12.1");
  });

  it("after the temporary link and before the rename: the next switch removes the leftover", async () => {
    const state = await runSwitch("before-rename", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.previous);
    expect(state.temporaryLinks()).toHaveLength(1);

    const capture = await capturePackageReleaseSlot(state.slot);
    if (capture.kind !== "link") {
      throw new Error("expected the old link");
    }
    await switchPackageReleaseLink({
      slot: state.slot,
      expected: capture,
      target: path.relative(state.globalRoot, state.candidate),
      assertCurrent: () => {},
    });
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.candidate);
    expect(state.temporaryLinks()).toEqual([]);
  });

  it("after the rename and before confirmation: the link names the complete candidate", async () => {
    const state = await runSwitch("after-rename", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.candidate);
    expect(version(state.slot)).toBe("2026.12.1");
    expect(state.temporaryLinks()).toEqual([]);
    // The next run reads the link; rolling back repeats the switch with the old text.
    const capture = await capturePackageReleaseSlot(state.slot);
    if (capture.kind !== "link") {
      throw new Error("expected the candidate link");
    }
    await switchPackageReleaseLink({
      slot: state.slot,
      expected: capture,
      target: path.relative(state.globalRoot, state.previous),
      assertCurrent: () => {},
    });
    expect(version(state.slot)).toBe("2026.11.3");
  });

  it.runIf(expectedPathExchangeRoute)(
    "at every boundary of an adoption: the package path serves a complete package",
    async () => {
      const { labels, killed, detail } = await killAtEveryBoundary();

      expect(killed.filter((run) => run.installed === null).map((run) => run.label)).toEqual([]);
      // The old package serves until the link switch, the new one after it.
      const switched = labels.findLastIndex((label) => label.startsWith("rename "));
      expect(killed.map((run) => run.installed)).toEqual(
        labels.map((_, index) => (index < switched ? "2026.11.3" : "2026.12.1")),
      );
      // The sweep cut on both sides of the exchange tool, which is what adopted the directory.
      expect(labels.filter((label) => /^(start|end) /u.test(label))).toHaveLength(2);
      expect(detail).toContain(`by an atomic exchange (${expectedPathExchangeRoute})`);
    },
  );

  it("without an exchange tool: only the instant between the two renames has no package", async () => {
    const { killed, detail } = await killAtEveryBoundary("missing");
    expect(detail).toMatch(/two renames \(atomic exchange unavailable: .*ENOENT/u);

    const broken = killed.filter((run) => run.installed === null);
    expect(broken.map((run) => run.label)).toEqual([
      "rename lib/node_modules/openclaw -> releases/2026.11.3/lib/node_modules/openclaw",
    ]);
    const state = broken[0]!.state;
    expect(fs.lstatSync(state.slot, { throwIfNoEntry: false })).toBeUndefined();
    const [leftover] = state.temporaryLinks();
    expect(leftover).toBeDefined();
    // The documented recovery: rename the leftover link onto the package path.
    fs.renameSync(path.join(state.globalRoot, leftover!), state.slot);
    expect(readPackageReleaseSlotSync(state.slot)).not.toBeNull();
    expect(version(state.slot)).toBe("2026.11.3");
    expect(fs.readlinkSync(path.join(state.prefix, "bin", "openclaw"))).toBe(
      "../lib/node_modules/openclaw/openclaw.mjs",
    );
  });

  it("before the exchange: the next update adopts again and collection removes the leftover", async () => {
    // Killed with the link for the package path already waiting in the release.
    const state = await runSwitch("after-waiting-link", "plain");
    const releases = path.join(state.prefix, "releases");
    const leftover = fs.readdirSync(releases).find((id) => id.startsWith("2026.11.3-"))!;
    const waiting = path.join(releases, leftover, "lib", "node_modules", "openclaw");
    expect(fs.lstatSync(waiting).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(waiting)).toBe(false);
    expect(version(state.slot)).toBe("2026.11.3");

    const next = await stagePackageRelease(
      { prefix: state.prefix, globalRoot: state.globalRoot, slot: state.slot },
      "2026.12.2",
    );
    const result = await swapStagedPackageInstall({ ...next, onTransaction: () => {} });

    expect(result.status).toBe("committed");
    expect(version(state.slot)).toBe("2026.12.2");
    // `openclaw update status` lists releases; the leftover and its dangling link are not one.
    const listed = await listPackageReleases(state.slot);
    expect(new Set(listed.map((release) => release.version))).toEqual(
      new Set(["2026.11.3", "2026.12.1", "2026.12.2"]),
    );
    expect(listed.map((release) => release.id)).not.toContain(leftover);
    const collected = await collectPackageReleases({
      slot: state.slot,
      prefix: state.prefix,
      readOpenRuns: async () => [],
      now: Date.now() + 2 * 24 * 60 * 60 * 1000,
    });
    expect(collected.warnings).toEqual([]);
    expect(collected.removed).toContain(path.join(releases, leftover));
    expect(fs.existsSync(path.join(releases, leftover))).toBe(false);
  });
});
