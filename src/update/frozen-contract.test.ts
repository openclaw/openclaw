import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, expectTypeOf, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginStateUpgradeRestore,
  publishStateUpgradeRestore,
} from "../state/state-upgrade-restore.js";
import { withEnvAsync } from "../test-utils/env.js";
import { TRIAL_BUDGET_MS } from "./launcher.js";
import { MANIFEST_RESTORE_SOURCE } from "./rollback-source.js";
import { createTrialPending, readTrial, resolvePrefix, writeTrial, type Trial } from "./store.js";

// These are independent format-4 wire expectations, not generated schema snapshots.
// launcher.test.ts owns the format, two-start, stage-deadline and exit-78 lifecycle cases.
const dirs = useAutoCleanupTempDirTracker(afterEach);

async function candidate(optional: { buildId?: string; acceptCapabilities?: boolean } = {}) {
  const state = dirs.make("frozen-launcher-contract-");
  const env = {
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "operator.json"),
  };
  const prefix = resolvePrefix(env);
  const input = {
    runId: "contract-run",
    target: path.join("releases", "candidate", "openclaw"),
    previous: path.join("releases", "previous", "openclaw"),
    version: "2.0.0",
    ...optional,
  };
  await fs.promises.mkdir(path.resolve(prefix, input.target), { recursive: true });
  const pending = await withEnvAsync(env, () => createTrialPending(input, prefix));
  return { state, env, prefix, input, pending };
}

async function activate(fixture: Awaited<ReturnType<typeof candidate>>) {
  // The candidate publisher runs after the launcher makes this existing transition.
  await writeTrial(
    { ...fixture.pending, phase: "trial", createdAt: Date.now(), attempts: 1 },
    fixture.prefix,
  );
  const trial = await readTrial(fixture.prefix);
  if (!trial) {
    throw new Error("The real trial writer did not persist its record");
  }
  return trial;
}

it("pins the candidate's persisted trial ABI and the frozen twenty-minute default", async () => {
  expect(TRIAL_BUDGET_MS).toBe(1_200_000);
  expectTypeOf<Trial["v"]>().toEqualTypeOf<2>();
  expectTypeOf<keyof Trial>().toEqualTypeOf<
    | "v"
    | "runId"
    | "phase"
    | "target"
    | "previous"
    | "buildId"
    | "version"
    | "createdAt"
    | "attempts"
    | "config"
    | "acceptCapabilities"
    | "restoring"
    | "outcome"
    | "reported"
  >();

  for (const optional of [{}, { buildId: "target-build", acceptCapabilities: true }]) {
    const fixture = await candidate(optional);
    const encoded: unknown = JSON.parse(
      fs.readFileSync(path.join(fixture.prefix, "releases", ".trial"), "utf8"),
    );
    expect(encoded).toEqual({
      ...fixture.input,
      v: 2,
      phase: "pending",
      createdAt: 0,
      attempts: 0,
      config: fixture.env.OPENCLAW_CONFIG_PATH,
    });
  }
});

it("feeds the real candidate restore receipt to the frozen manifest reader", async () => {
  const fixture = await candidate();
  await activate(fixture);
  const live = path.join(fixture.state, "authored-file");
  const added = path.join(fixture.state, "boot-created-file");
  fs.writeFileSync(live, "original");
  const complete = await publishStateUpgradeRestore(await beginStateUpgradeRestore(fixture.env), {
    targets: [
      { path: live, engine: "file" },
      { path: added, engine: "file" },
    ],
    config: {},
  });
  fs.writeFileSync(live, "candidate");
  fs.writeFileSync(added, "created during boot");
  complete?.();
  expect(fs.readFileSync(live, "utf8")).toBe("candidate");
  expect(fs.existsSync(added)).toBe(true);

  // Pin the deployed format independently: the current writer and reader can evolve together.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixture.prefix, "releases", "candidate", ".restore"), "utf8"),
  );
  expect(manifest).toEqual({
    v: 1,
    runId: fixture.input.runId,
    files: expect.arrayContaining([
      { live, preimage: expect.any(String) },
      { live: added, preimage: null },
    ]),
  });
  expect(manifest.files).toHaveLength(2);
  const image = manifest.files.find((entry: { live: string }) => entry.live === live);
  expect(path.isAbsolute(image.preimage)).toBe(true);

  runInNewContext(
    `${MANIFEST_RESTORE_SOURCE}\nrestoreManifestFiles(readRestoreManifest(trial, false));`,
    {
      fs,
      path,
      trial: await readTrial(fixture.prefix),
      linked: (target: string) => path.resolve(fixture.prefix, target),
    },
  );
  expect(fs.readFileSync(live, "utf8")).toBe("original");
  expect(fs.existsSync(added)).toBe(false);
});

it("exchanges real candidate ready and stop frames with a pinned format-4 peer", async ({
  signal,
}) => {
  const fixture = await candidate({ buildId: "target-build" });
  const active = await activate(fixture);
  const announced = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const frames: unknown[] = [];
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { announceReady } from ${JSON.stringify(new URL("./gateway-trial.ts", import.meta.url).href)};
       process.stdin.resume();
       await announceReady("wire-build");
       process.send({ fixture: "returned" });`,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            ["path", "systemroot", "windir", "comspec"].includes(key.toLowerCase()),
          ),
        ),
        HOME: fixture.state,
        USERPROFILE: fixture.state,
        TMPDIR: fixture.state,
        TEMP: fixture.state,
        TMP: fixture.state,
        ...fixture.env,
        NODE_OPTIONS: "",
        OPENCLAW_LAUNCHER_IPC: "1",
      },
      stdio: ["pipe", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  const prematureExit = exited.then(() => {
    throw new Error(`Candidate IPC child exited before stop:\n${stderr}`);
  });
  void prematureExit.catch(() => {});
  child.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "fixture" in message) {
      if (message.fixture === "returned") {
        returned.resolve();
        announced.resolve();
      }
      return;
    }
    frames.push(message);
    announced.resolve();
    if (message && typeof message === "object" && "type" in message) {
      if (message.type === "openclaw.ready") {
        // A mismatched build receives the still-active record from a format-4 peer.
        child.send({ type: "openclaw.trial", trial: active });
      }
    }
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(announced.promise, prematureExit, "Missing candidate ready frame"),
      signal,
    );
    expect(frames).toEqual([{ type: "openclaw.ready", buildId: "wire-build" }]);
    await withinTest(
      awaitGateBeforeSettlement(
        returned.promise,
        prematureExit,
        "Candidate did not accept its peer",
      ),
      signal,
    );
    // Returning can also use the supported file fallback; this does not pin ACK parsing latency.
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    child.send({ type: "openclaw.stop" });
    await withinTest(exited, signal);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}, 15_000);
