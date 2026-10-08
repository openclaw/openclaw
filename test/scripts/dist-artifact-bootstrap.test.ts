import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runNativeTsgoArtifactEntry } from "../../scripts/lib/dist-artifact-lock.mts";
import * as managed from "../../scripts/lib/managed-child-process.mts";
import * as policy from "../../scripts/lib/vitest-worker-cache-policy.mts";
import * as workers from "../../scripts/lib/vitest-worker-run.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

const fixture = createFixtureLifetime();
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.cleanup();
});

it.runIf(process.platform === "linux" && !process.versions.bun).for([130, 129])(
  "preserves completed bootstrap exit %s only after disposal",
  async (code) => {
    const root = fs.realpathSync(fixture.createTempDir("artifact-bootstrap-"));
    fs.mkdirSync(path.join(root, ".git"));
    const compiler = path.join(root, "compiler");
    fs.writeFileSync(compiler, "");
    vi.stubEnv("OPENCLAW_TSGO_METRICS_DIR", "");
    vi.spyOn(policy, "hasUntrackedRuntimeInputs").mockReturnValue(false);
    vi.spyOn(managed, "runManagedCommand").mockResolvedValue(code);
    const create = workers.createVitestWorkerRun;
    let directory: string | undefined;
    vi.spyOn(workers, "createVitestWorkerRun").mockImplementation((...args) => {
      const run = create(...args);
      directory = run.descriptor.directory;
      return run;
    });
    expect(await runNativeTsgoArtifactEntry(root, [], compiler)).toBe(code);
    expect(directory).toBeDefined();
    expect(fs.existsSync(directory!)).toBe(false);
    expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock"))).toBe(false);
  },
);

it.runIf(process.platform === "linux" && !process.versions.bun)(
  "does not hide bootstrap disposal failure behind a signal status",
  async () => {
    const root = fs.realpathSync(fixture.createTempDir("artifact-bootstrap-error-"));
    fs.mkdirSync(path.join(root, ".git"));
    const compiler = path.join(root, "compiler");
    fs.writeFileSync(compiler, "");
    vi.stubEnv("OPENCLAW_TSGO_METRICS_DIR", "");
    vi.spyOn(policy, "hasUntrackedRuntimeInputs").mockReturnValue(false);
    vi.spyOn(managed, "runManagedCommand").mockResolvedValue(130);
    const create = workers.createVitestWorkerRun;
    const failure = new Error("fixture disposal failed");
    vi.spyOn(workers, "createVitestWorkerRun").mockImplementation((...args) => {
      const run = create(...args);
      return {
        ...run,
        dispose: async () => {
          await run.dispose().catch((error: unknown) => {
            if (!(error instanceof workers.CompiledSubprocessExitError)) {
              throw error;
            }
          });
          throw failure;
        },
      };
    });
    await expect(runNativeTsgoArtifactEntry(root, [], compiler)).rejects.toBe(failure);
  },
);
