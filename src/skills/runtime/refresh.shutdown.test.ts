import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { WorkerTaskPool as Pool } from "../../infra/worker-task-pool.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import * as refresh from "./refresh.js";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  changed: [] as Array<() => void>,
  scan: undefined as
    | { entered: PromiseWithResolvers<void>; retired: PromiseWithResolvers<void> }
    | undefined,
}));

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn: mocks.warn,
    }),
  };
});
vi.mock("../../infra/owned-directory-observation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/owned-directory-observation.js")>();
  return {
    ...actual,
    observeOwnedDirectory: (...args: Parameters<typeof actual.observeOwnedDirectory>) => {
      mocks.changed.push(args[1]);
      return actual.observeOwnedDirectory(...args);
    },
  };
});
vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-pool.js")>();
  // While a scan is armed, hold its worker request so the test can retire the pool underneath it.
  class HeldPool<I, O> extends actual.WorkerTaskPool<I, O> {
    override async run(...args: Parameters<Pool<I, O>["run"]>) {
      if (mocks.scan) {
        mocks.scan.entered.resolve();
        await mocks.scan.retired.promise;
      }
      return super.run(...args);
    }
  }
  return { ...actual, WorkerTaskPool: HeldPool };
});

const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await refresh.closeSkillsWatchers(true);
    } finally {
      mocks.changed.length = 0;
      mocks.scan = undefined;
      mocks.warn.mockClear();
      vi.unstubAllEnvs();
      cleanup();
    }
  }),
);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", temporary.make("skills-shutdown-state-"));
});

it("does not warn when shutdown interrupts a passive refresh", async () => {
  const workspace = temporary.make("skills-shutdown-");
  await fs.mkdir(path.join(workspace, "skills"), { recursive: true });
  await writeSkill({
    dir: path.join(workspace, "skills", "guide"),
    name: "guide",
    description: "Guide",
  });
  await refresh.ensureSkillsWatcher({
    workspaceDir: workspace,
    config: { skills: { load: { watch: true } } },
  });
  expect(mocks.changed.length).toBeGreaterThan(0);

  // A directory change arms a passive scan; a CLI exit then retires discovery while it is running.
  mocks.scan = { entered: Promise.withResolvers<void>(), retired: Promise.withResolvers<void>() };
  mocks.changed.at(-1)!();
  await mocks.scan.entered.promise;
  const closing = refresh.closeSkillsWatchers();
  mocks.scan.retired.resolve();
  await closing;

  expect(mocks.warn).not.toHaveBeenCalledWith(
    expect.stringContaining("passive skills refresh failed"),
  );
});
