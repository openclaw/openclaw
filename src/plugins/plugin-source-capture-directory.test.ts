import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { retainGatewayPluginMetadata } from "./plugin-metadata-lifecycle.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import {
  createPluginSourceCaptureRoot,
  sweepPluginSourceCaptureDirectories,
} from "./plugin-source-capture-directory.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const artifactUrl = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.artifact);
const artifactModule = artifactUrl.href;
const runtimeArgs = resolveRuntimeWorkerArgv(artifactUrl).slice(0, -1);
const hour = 60 * 60 * 1_000;
const capturedSource = "module.exports = 'captured';\n";

beforeEach(() => {
  const runtimeTemp = temp.make("plugin-capture-runtime-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, runtimeTemp);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function createSource(): string {
  const source = temp.make("plugin-capture-input-");
  fs.writeFileSync(path.join(source, "index.cjs"), capturedSource);
  return source;
}

function age(directory: string): void {
  const timestamp = new Date(Date.now() - 2 * hour);
  fs.utimesSync(directory, timestamp, timestamp);
}

function capturePaths(
  stateDir: string,
  boundaryRoot: string,
  capturedFile: string,
  worker = false,
) {
  const captureRoot = worker ? path.dirname(boundaryRoot) : boundaryRoot;
  const instanceRoot = path.dirname(path.dirname(captureRoot));
  // Check ownership before aging a path derived from a child or an older implementation.
  expect(path.dirname(instanceRoot)).toBe(path.join(stateDir, "tmp", "plugin-captures"));
  return {
    boundaryRoot,
    capturedFile,
    captureRoot,
    instanceRoot,
  };
}

const childCapture = `
  import fs from "node:fs";
  import path from "node:path";
  import { capturePluginGenerationArtifact } from ${JSON.stringify(artifactModule)};
  import { createPluginSourceCaptureRoot } from ${JSON.stringify(resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.captureDirectory).href)};
  import { withPluginSourceCaptureDirectory } from ${JSON.stringify(resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.metadataCapture).href)};
  const source = process.argv[1];
  const worker = process.argv[2] === "worker"
    ? createPluginSourceCaptureRoot(process.env.OPENCLAW_STATE_DIR, "openclaw-model-catalog-")
    : undefined;
  const artifact = worker
    ? withPluginSourceCaptureDirectory(worker.directory, () => capturePluginGenerationArtifact(source))
    : capturePluginGenerationArtifact(source);
  const capturedFile = artifact.resolve(path.join(source, "index.cjs"));
  fs.writeSync(1, artifact.boundaryRoot + "\\n" + capturedFile + "\\n");
`;

async function abandonCapture(stateDir: string, source: string) {
  const captured = await startCliCapture(stateDir, source, false);
  await captured.stop();
  expect(fs.readFileSync(captured.capturedFile, "utf8")).toBe(capturedSource);
  return captured;
}

it.each(["natural", "failure", "explicit", "signal"])(
  "reclaims process-owned captures on %s exit",
  (mode) => {
    const stateDir = temp.make("plugin-capture-exit-");
    const source = createSource();
    const signalModule = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.signalExit).href;
    const result = spawnSync(
      process.execPath,
      [
        ...runtimeArgs,
        "--input-type=module",
        "-e",
        `${childCapture}
      import { installCliSignalExitHandlers } from ${JSON.stringify(signalModule)};
      const mode = process.argv[2];
      if (mode === "failure") throw new Error("fixture command failed");
      if (mode === "explicit") process.exit(2);
      if (mode === "signal") {
        installCliSignalExitHandlers();
        process.emit("SIGTERM");
      }`,
        source,
        mode,
      ],
      {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(
      mode === "natural" ? 0 : mode === "failure" ? 1 : mode === "explicit" ? 2 : 143,
    );
    const [directory] = result.stdout.trim().split("\n");
    expect(directory).toContain(path.join(stateDir, "tmp", "plugin-captures"));
    expect(fs.existsSync(directory!)).toBe(false);
    expect(fs.readdirSync(path.join(stateDir, "tmp", "plugin-captures"))).toEqual([]);
  },
);

async function startCliCapture(stateDir: string, source: string, worker: boolean) {
  const child = spawn(
    process.execPath,
    [
      ...runtimeArgs,
      "--input-type=module",
      "-e",
      `${childCapture}
       process.stdin.on("data", () => fs.writeSync(1, fs.readFileSync(capturedFile)));
       process.stdin.resume();`,
      source,
      worker ? "worker" : "cli",
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        TMPDIR: stateDir,
        TMP: stateDir,
        TEMP: stateDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  void exited.catch(() => {});
  const nextLine = async () => {
    const result = await lines.next();
    if (result.done) {
      throw new Error(`Capture child exited before replying: ${stderr}`);
    }
    return result.value;
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    reader.close();
  };
  try {
    const boundaryRoot = await nextLine();
    const capturedFile = await nextLine();
    return {
      ...capturePaths(stateDir, boundaryRoot, capturedFile, worker),
      async read() {
        child.stdin.write("read\n");
        return await nextLine();
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

it("metadata boot reclaims old abandoned artifacts and preserves recent and legacy files", async () => {
  const stateDir = temp.make("plugin-capture-boot-");
  const source = createSource();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const active = capturePluginGenerationArtifact(source);
  // Finish standalone acquisition before a Gateway joins the same process later.
  await sweepPluginSourceCaptureDirectories(stateDir);
  const old = await abandonCapture(stateDir, source);
  const recent = await abandonCapture(stateDir, source);
  age(old.instanceRoot);
  const legacy = path.join(temp.make("plugin-capture-legacy-"), "openclaw-plugin-build-legacy");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "sentinel"), "legacy files have no custody token");
  age(legacy);
  vi.stubEnv("TMPDIR", path.dirname(legacy));

  const metadata = retainGatewayPluginMetadata();
  try {
    await vi.waitFor(() => expect(fs.existsSync(old.instanceRoot)).toBe(false));
    expect(fs.readFileSync(active.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    expect(fs.readFileSync(recent.capturedFile, "utf8")).toBe(capturedSource);
    expect(fs.readFileSync(path.join(legacy, "sentinel"), "utf8")).toBe(
      "legacy files have no custody token",
    );
  } finally {
    await metadata.close();
    active.dispose();
    await sweepPluginSourceCaptureDirectories(stateDir);
  }
}, 30_000);

it.each([false, true])(
  "preserves live custody, then reclaims after SIGKILL (worker root: %s)",
  async (worker) => {
    const stateDir = temp.make("plugin-capture-cli-");
    const child = await startCliCapture(stateDir, createSource(), worker);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      age(child.instanceRoot);
      const metadata = retainGatewayPluginMetadata();
      try {
        await sweepPluginSourceCaptureDirectories(stateDir);
        expect(await child.read()).toBe(capturedSource.trim());
        expect(fs.existsSync(child.captureRoot)).toBe(true);
        expect(fs.readFileSync(child.capturedFile, "utf8")).toBe(capturedSource);
        await child.stop();
        expect(fs.readFileSync(child.capturedFile, "utf8")).toBe(capturedSource);
        await sweepPluginSourceCaptureDirectories(stateDir);
        expect(fs.existsSync(child.instanceRoot)).toBe(false);
        expect(fs.existsSync(child.captureRoot)).toBe(false);
      } finally {
        await metadata.close();
      }
    } finally {
      await child.stop();
    }
  },
  30_000,
);

it.each(["payload", "instance"])(
  "retries an abandoned instance after a partial %s removal failure is resolved",
  async (stage) => {
    const stateDir = temp.make("plugin-capture-partial-removal-");
    const orphan = await abandonCapture(stateDir, createSource());
    age(orphan.instanceRoot);
    const captures = path.dirname(orphan.boundaryRoot);
    const remove = fsPromises.rm.bind(fsPromises);
    const failure = Object.assign(new Error("Fixture cleanup cannot finish"), { code: "EACCES" });
    const fault = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (target === (stage === "payload" ? captures : orphan.instanceRoot)) {
        throw failure;
      }
      await remove(target, options);
    });
    try {
      await sweepPluginSourceCaptureDirectories(stateDir);
      expect(fs.existsSync(path.join(orphan.instanceRoot, "owner.sqlite"))).toBe(true);
      if (stage === "payload") {
        expect(fs.readFileSync(orphan.capturedFile, "utf8")).toBe(capturedSource);
      } else {
        expect(fs.existsSync(captures)).toBe(false);
      }
    } finally {
      fault.mockRestore();
    }
    age(orphan.instanceRoot);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.existsSync(orphan.instanceRoot)).toBe(false);
  },
  30_000,
);

it("retries reclamation when a long-lived metadata owner's hourly scan reaches the grace period", async () => {
  const stateDir = temp.make("plugin-capture-periodic-");
  const orphan = await abandonCapture(stateDir, createSource());
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const metadata = retainGatewayPluginMetadata();
  try {
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(orphan.capturedFile, "utf8")).toBe(capturedSource);
    await vi.advanceTimersByTimeAsync(2 * hour);
    await vi.waitFor(() => expect(fs.existsSync(orphan.instanceRoot)).toBe(false));
  } finally {
    await metadata.close();
    await sweepPluginSourceCaptureDirectories(stateDir);
    vi.useRealTimers();
  }
}, 30_000);

it.each(["before command", "inside command"])(
  "does not retain the first CLI context when the capture loader is imported %s",
  (importOrder) => {
    const stateDir = temp.make("plugin-capture-context-");
    const source = createSource();
    const cleanupModule = resolveRuntimeWorkerUrl(
      pluginProcessRuntimeEntrypoints.cleanupScope,
    ).href;
    const result = execFileSync(
      process.execPath,
      [
        ...runtimeArgs,
        "--input-type=module",
        "--eval",
        `
        import { AsyncLocalStorage, createHook } from "node:async_hooks";
        import fs from "node:fs";
        import path from "node:path";
        import {
          getCliPluginInvocationResources, withCliCommandCleanup, withCliProcessScope,
        } from ${JSON.stringify(cleanupModule)};
        const load = () => import(${JSON.stringify(artifactModule)});
        if (process.argv[2] === "before command") await load();
        const request = new AsyncLocalStorage();
        const observed = [];
        const hook = createHook({ init(id, type, trigger, resource) {
          if (type === "Timeout") observed.push({
            resource, context: request.getStore() ?? null,
            cli: Boolean(getCliPluginInvocationResources()),
          });
        }});
        const { artifact: first, cleanup } = await request.run("first-command", () =>
          withCliProcessScope(() => withCliCommandCleanup(false, async (cleanup) => {
            const { capturePluginGenerationArtifact } = await load();
            hook.enable();
            try {
              return { artifact: capturePluginGenerationArtifact(process.argv[1]), cleanup };
            } finally {
              hook.disable();
            }
          })),
        );
        const { capturePluginGenerationArtifact } = await load();
        const survivor = capturePluginGenerationArtifact(process.argv[1]);
        first.dispose();
        await cleanup.pluginResources.release();
        try {
          process.stdout.write(JSON.stringify({
            timers: observed.map(({ resource, context, cli }) => ({
              context, cli, referenced: resource.hasRef(),
            })),
            source: fs.readFileSync(survivor.resolve(path.join(process.argv[1], "index.cjs")), "utf8"),
          }));
        } finally {
          survivor.dispose();
        }
        `,
        source,
        importOrder,
      ],
      { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, encoding: "utf8", timeout: 15_000 },
    );
    expect(JSON.parse(result)).toEqual({
      timers: [{ context: null, cli: false, referenced: false }],
      source: capturedSource,
    });
  },
);

it("retains live capture bytes until both metadata owners and the artifact release custody", async () => {
  const stateDir = temp.make("plugin-capture-shared-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const source = createSource();
  const first = retainGatewayPluginMetadata();
  let second: ReturnType<typeof retainGatewayPluginMetadata> | undefined;
  let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
  try {
    second = retainGatewayPluginMetadata();
    artifact = capturePluginGenerationArtifact(source);
    const { instanceRoot } = capturePaths(
      stateDir,
      artifact.boundaryRoot,
      artifact.resolve(path.join(source, "index.cjs")),
    );
    age(instanceRoot);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    await first.close();
    await first.close();
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    await second.close();
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    await artifact.disposeAsync();
    expect(fs.existsSync(instanceRoot)).toBe(false);
  } finally {
    try {
      await artifact?.disposeAsync();
    } finally {
      await Promise.all([first.close(), second?.close()]);
    }
  }
});

it("leaves explicit worker capture directories under their caller's custody", async () => {
  const stateDir = temp.make("plugin-capture-worker-state-");
  const workerRoot = temp.make("plugin-capture-worker-");
  const source = createSource();
  fs.writeFileSync(path.join(workerRoot, "sentinel"), "worker owns this directory");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const artifact = withPluginSourceCaptureDirectory(workerRoot, () =>
    capturePluginGenerationArtifact(source),
  );
  try {
    age(artifact.boundaryRoot);
    const metadata = retainGatewayPluginMetadata();
    try {
      await sweepPluginSourceCaptureDirectories(stateDir);
      expect(path.dirname(artifact.boundaryRoot)).toBe(workerRoot);
      expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
        capturedSource,
      );
    } finally {
      await metadata.close();
    }
  } finally {
    await artifact.disposeAsync();
  }
  expect(fs.existsSync(artifact.boundaryRoot)).toBe(false);
  expect(fs.readFileSync(path.join(workerRoot, "sentinel"), "utf8")).toBe(
    "worker owns this directory",
  );
});

it("excludes managed worker output when the state directory is also plugin source", async () => {
  const source = createSource();
  const root = createPluginSourceCaptureRoot(source, "openclaw-model-catalog-");
  let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
  try {
    artifact = withPluginSourceCaptureDirectory(
      root.directory,
      () => capturePluginGenerationArtifact(source),
      root.managedRoot,
    );
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    expect(fs.existsSync(path.join(artifact.rootDir, "tmp", "plugin-captures"))).toBe(false);
  } finally {
    await artifact?.disposeAsync();
    await root.release();
  }
});

it("keeps metadata boot and source capture usable when the state directory cannot contain captures", async () => {
  const parent = temp.make("plugin-capture-malformed-state-");
  const stateDir = path.join(parent, "state");
  fs.writeFileSync(stateDir, "not a directory");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const source = createSource();
  const metadata = retainGatewayPluginMetadata();
  let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
  let instanceRoot: string | undefined;
  try {
    await sweepPluginSourceCaptureDirectories(stateDir);
    artifact = capturePluginGenerationArtifact(source);
    instanceRoot = path.dirname(path.dirname(artifact.boundaryRoot));
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    expect(fs.readFileSync(stateDir, "utf8")).toBe("not a directory");
  } finally {
    try {
      await artifact?.disposeAsync();
    } finally {
      await metadata.close();
    }
  }
  expect(instanceRoot).toBeDefined();
  expect(fs.existsSync(instanceRoot!)).toBe(false);
});

// Failure injection sits at the filesystem boundary; captures still exercise the real allocator.
it.each(["captures", "first capture"])(
  "falls back when ENOSPC interrupts allocation of the %s directory",
  async (stage) => {
    const stateDir = temp.make("plugin-capture-full-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const mkdir = fs.mkdirSync.bind(fs);
    const mkdtemp = fs.mkdtempSync.bind(fs);
    const failure = Object.assign(new Error("Fixture state filesystem is full"), {
      code: "ENOSPC",
    });
    if (stage === "captures") {
      vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
        if (
          String(target).startsWith(stateDir + path.sep) &&
          path.basename(String(target)) === "captures"
        ) {
          throw failure;
        }
        return mkdir(target, options);
      });
    } else {
      vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix, options) => {
        if (prefix.startsWith(stateDir + path.sep)) {
          throw failure;
        }
        return mkdtemp(prefix, options);
      });
    }
    const source = createSource();
    const artifact = capturePluginGenerationArtifact(source);
    try {
      expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
        capturedSource,
      );
      expect(artifact.boundaryRoot.startsWith(stateDir + path.sep)).toBe(false);
      expect(fs.readdirSync(path.join(stateDir, "tmp", "plugin-captures"))).toEqual([]);
    } finally {
      await artifact.disposeAsync();
    }
    expect(fs.existsSync(artifact.boundaryRoot)).toBe(false);
  },
);

it("summarizes inaccessible coordinators with backoff while continuing cleanup retries", async () => {
  const stateDir = temp.make("plugin-capture-warning-backoff-");
  const root = path.join(stateDir, "tmp", "plugin-captures");
  for (let index = 0; index < 100; index++) {
    const directory = path.join(root, String(index));
    fs.mkdirSync(path.join(directory, "captures"), { recursive: true });
    fs.writeFileSync(path.join(directory, "owner.sqlite"), "");
    age(directory);
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const lstat = fsPromises.lstat.bind(fsPromises);
  const fault = vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
    if (
      String(target).startsWith(root + path.sep) &&
      path.basename(String(target)) === "owner.sqlite"
    ) {
      throw Object.assign(new Error("Fixture coordinator is inaccessible"), { code: "EACCES" });
    }
    return lstat(target, options);
  });
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(String(warning.mock.calls[0]?.[0])).toContain("100 cleanup failure(s)");
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(warning).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + hour);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(warning).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + hour);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(warning).toHaveBeenCalledTimes(2);
  fault.mockRestore();
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.readdirSync(root)).toEqual([]);
});
