import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  WorktreeTemplateActivity,
  WorktreeTemplateRecipe,
  WorktreeTemplateSelection,
} from "../agents/worktrees/template-prewarm.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startWorkspaceTemplatePrewarm } from "./workspace-template-prewarm.js";

const mocks = vi.hoisted(() => ({
  notify: (_event: WorktreeTemplateActivity) => {},
  prepare:
    vi.fn<
      typeof import("./worker-environments/workspace-template-prewarm.js").prewarmWorkspaceTemplate
    >(),
}));
// mock-isolation: Scheduling consumes owner events; native template custody is tested in the template owner suite.
vi.mock("../agents/worktrees/run-end-lifecycle.js", () => ({
  onWorktreeTemplateActivity: (_env: NodeJS.ProcessEnv, listener: typeof mocks.notify) => {
    mocks.notify = listener;
    return () => {
      mocks.notify = () => {};
    };
  },
}));
// mock-isolation: Hold native preparation to prove scheduler cancellation without container processes.
vi.mock("./worker-environments/workspace-template-prewarm.js", () => ({
  prewarmWorkspaceTemplate: mocks.prepare,
}));
// mock-isolation: Synthetic scheduler proofs run with idle host IO.
vi.mock("../infra/host-io-pressure.js", () => ({
  createHostIoPressureProbe: () => async () => false,
}));

beforeEach(() => {
  resetGatewayWorkAdmission();
  mocks.prepare.mockReset().mockResolvedValue();
});
afterEach(() => resetGatewayWorkAdmission());

function fixture() {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  let config: OpenClawConfig = {};
  const errors = vi.fn();
  const owner = startWorkspaceTemplatePrewarm({
    scheduler: scheduler.scope(),
    getConfig: () => config,
    onError: errors,
  });
  const recipe: WorktreeTemplateRecipe = {
    kind: "managed",
    sourceOnly: true,
    template: {
      id: "initial",
      cacheKey: "managed",
      sourceCommit: "a",
      contentKey: "a",
      backend: "btrfs",
      status: "ready",
      path: "/fixture/template",
      repoRoot: "/fixture",
      commonDir: "/fixture/.git",
      worktreeRoot: "/fixture/worktrees",
      createdAt: 0,
      lastUsedAt: 0,
    },
  };
  return {
    clock,
    recipe,
    errors,
    use: () => mocks.notify({ type: "used", recipe }),
    advance: (commit: string) =>
      mocks.notify({ type: "base", commonDir: recipe.template.commonDir, commit }),
    preparation: (active: boolean, selection?: WorktreeTemplateSelection, background?: boolean) =>
      mocks.notify({ type: "preparation", selection, background, active }),
    replaceConfig: () => {
      config = { worktreeAcceleration: false };
    },
    async [Symbol.asyncDispose]() {
      owner.stop();
      await scheduler.stop();
    },
  };
}

it("coalesces advancing main to the newest head for used templates only", async () => {
  await using f = fixture();
  f.advance("b");
  await f.clock.advanceBy(30_000);
  expect(mocks.prepare).not.toHaveBeenCalled();
  f.use();
  f.preparation(false); // Settlement from a preparation predating this subscriber.
  f.advance("b");
  await f.clock.advanceBy(10_000);
  f.advance("c");
  await f.clock.advanceBy(29_999);
  expect(mocks.prepare).not.toHaveBeenCalled();
  await f.clock.advanceBy(1);
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(f.recipe, "c", expect.anything());
  f.advance("d");
  f.recipe.template.sourceCommit = "e";
  f.use();
  f.advance("e");
  await f.clock.advanceBy(30_000);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  f.advance("f");
  f.recipe.template.sourceCommit = "f";
  f.use();
  await f.clock.advanceBy(30_000);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
});

it.each([
  [{ cacheKey: "sandbox" }, true],
  [{ contentKey: "different-policy" }, false],
  [{ backend: "different-backend" }, false],
])(
  "yields unused builds and waits through application (selection=%j, other request finished=%s)",
  async (different, otherFinished) => {
    await using f = fixture();
    f.use();
    f.preparation(true);
    f.advance("b");
    await f.clock.advanceBy(30_000);
    expect(mocks.prepare).not.toHaveBeenCalled();
    f.preparation(false);
    const selection = { cacheKey: "managed", contentKey: "b", backend: "btrfs" };
    const entered = createDeferred<{ signal: AbortSignal; assertCurrent: () => void }>();
    const cleanup = createDeferred();
    mocks.prepare.mockImplementationOnce(async (_recipe, _commit, { signal, commitGuard }) => {
      f.preparation(true, selection, true);
      entered.resolve({ signal, assertCurrent: commitGuard });
      try {
        await cleanup.promise;
        commitGuard();
      } finally {
        f.preparation(false, selection, true);
      }
    });
    const running = f.clock.advanceBy(30_000);
    const { signal, assertCurrent } = await entered.promise;
    try {
      f.preparation(true);
      f.preparation(true, selection);
      expect(signal.aborted).toBe(false);
      const otherSelection = { ...selection, ...different };
      f.preparation(true, otherSelection);
      expect(signal.aborted).toBe(false);
      f.advance("c");
      assertCurrent();
      expect(signal.aborted).toBe(false);
      if (otherFinished) {
        f.preparation(false, otherSelection);
      }
      f.preparation(false, selection);
      expect(signal.aborted).toBe(true);
      f.advance("d");
      if (!otherFinished) {
        f.preparation(false, otherSelection);
      }
    } finally {
      cleanup.resolve();
      await running;
    }
    await f.clock.advanceBy(30_000);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    f.preparation(false);
    await f.clock.advanceBy(0);
    expect(mocks.prepare.mock.calls.map((call) => call[1])).toEqual(["b", "d"]);
    expect(f.errors).not.toHaveBeenCalled();
  },
);

it("drops queued preparation after configuration replacement", async () => {
  await using f = fixture();
  f.use();
  f.advance("b");
  f.replaceConfig();
  await f.clock.advanceBy(30_000);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
