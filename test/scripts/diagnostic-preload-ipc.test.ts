import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const preloadUrl = (name: string) =>
  new URL(name, new URL("../../scripts/perf/", import.meta.url)).href;

function childWithPreload(name: string, source: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    resolveTestNodeExecPath(),
    ["--import", preloadUrl(name), "--input-type=module", "-e", source, "gateway"],
    {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, ...env },
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout?.resume();
  const closed = once(child, "close");
  // A referenced diagnostic channel otherwise hangs forever, including after test failure.
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  void closed.finally(() => clearTimeout(deadline));
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  });
  return { child, closed, stderr: () => stderr };
}

it.each([
  "agent-event-frame-census-preload.mjs",
  "approval-replay-burst-probe.mjs",
  "bash-parser-gateway-preload.mjs",
  "owned-directory-load-counts-preload.mjs",
  "plugin-access-authority-census.mjs",
  "plugin-preparation-boot-preload.mjs",
  "plugin-scope-attribution-preload.mjs",
  "provider-rate-limit-stress-probe.mjs",
  "queued-input-retention-preload.mjs",
  "session-actor-receipt-retention-preload.mjs",
  "session-delete-phases-loader.mjs",
  "sqlite-reply-census-preload.mjs",
  "stall-recorder-cost-preload.mjs",
  "team-shape-module-census-preload.mjs",
  "team-shape-stress-loader.mjs",
  "timer-census-preload.mjs",
])("lets %s exit naturally with the parent still attached", async (name) => {
  const output = tempDirs.make("diagnostic-preload-ipc-");
  await writeFile(
    path.join(output, "team-shape-summary.json"),
    JSON.stringify({ format: "openclaw-team-shape-v1" }),
  );
  const preload = new URL(preloadUrl(name));
  if (name === "owned-directory-load-counts-preload.mjs") {
    preload.searchParams.set("output", path.join(output, "counts.json"));
  }
  const { closed, stderr } = childWithPreload(preload.href, "process.send({ ready: true });", {
    OPENCLAW_STATE_DIR: output,
    OPENCLAW_PLUGIN_BOOT_OUTPUT: output,
    OPENCLAW_DELETE_PHASE_OUTPUT: output,
    OPENCLAW_BENCH_OPERATOR_MODEL_POLICY_COUNTS: "1",
  });
  expect(await closed, stderr()).toEqual([0, null]);
});

it("handles census start/stop before releasing the host's last resource", async () => {
  const output = tempDirs.make("frame-census-ipc-");
  const { child, closed, stderr } = childWithPreload(
    "agent-event-frame-census-preload.mjs",
    `
    process.stdin.resume();
    process.on("message", (message) => {
      if (message.action === "start") {
        const census = globalThis[Symbol.for("openclaw.frame-census")];
        census.end(census.begin("synthetic-event"));
      }
      process.send({ handled: message.action });
    });
    process.send({ ready: true });
  `,
  );
  await once(child, "message");
  for (const action of ["start", "stop"]) {
    const handled = once(child, "message");
    child.send({ channel: "team-shape-stress", action, output });
    expect((await handled)[0]).toEqual({ handled: action });
  }
  child.stdin?.end();
  expect(await closed, stderr()).toEqual([0, null]);
  const census = JSON.parse(await readFile(path.join(output, "frame-census.json"), "utf8"));
  expect(census.complete).toBe(true);
  expect(census.events["synthetic-event"].events).toBe(1);
  const profile = JSON.parse(await readFile(path.join(output, "frame-census.heapprofile"), "utf8"));
  expect(profile.head).toBeDefined();
});

it.each([
  {
    name: "plugin-preparation-boot-preload.mjs",
    command: { channel: "openclaw.plugin-preparation-boot", action: "sample" },
    expected: { channel: "openclaw.plugin-preparation-boot" },
  },
  {
    name: "approval-replay-burst-probe.mjs",
    command: { approvalBurst: "start", allocation: true },
    expected: { started: true },
  },
])(
  "delivers $name replies as the host's last resource closes",
  async ({ name, command, expected }) => {
    const output = tempDirs.make("diagnostic-preload-reply-");
    const { child, closed, stderr } = childWithPreload(
      name,
      `
    process.stdin.resume();
    process.once("message", () => process.stdin.destroy());
    process.send({ ready: true });
  `,
      { OPENCLAW_PLUGIN_BOOT_OUTPUT: output },
    );
    await once(child, "message");
    const received = once(child, "message");
    child.send(command);
    expect((await received)[0]).toMatchObject(expected);
    expect(await closed, stderr()).toEqual([0, null]);
  },
);
