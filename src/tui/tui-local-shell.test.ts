import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as safeCwd from "../infra/safe-cwd.js";
import {
  getProcessSupervisor,
  type ManagedRun,
  type ProcessSupervisor,
} from "../process/supervisor/index.js";
import { SearchableSelectList } from "./components/searchable-select-list.js";
import { createLocalShellRunner } from "./tui-local-shell.js";
import { createOverlayHandle } from "./tui-overlay-handle.test-support.js";
import "./tui-overlay.test-support.js";

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: vi.fn(),
}));

function createShellSupervisor(
  spawn: ProcessSupervisor["spawn"] = vi.fn<ProcessSupervisor["spawn"]>(),
) {
  const cleanupScope = vi.fn(async (_scopeKey: string) => {});
  const cancelScope = vi.fn<ProcessSupervisor["cancelScope"]>();
  const supervisor = {
    spawn,
    cancel: vi.fn<ProcessSupervisor["cancel"]>(),
    cancelScope,
    acquireScopeCleanup: vi.fn<ProcessSupervisor["acquireScopeCleanup"]>((scopeKey) => async () => {
      cancelScope(scopeKey);
      await cleanupScope(scopeKey);
    }),
  } satisfies ProcessSupervisor;
  return { supervisor, cleanupScope };
}

const harnesses: Array<{ shutdown: () => Promise<void>; runs: Promise<void>[] }> = [];

afterEach(async () => {
  try {
    await Promise.all(harnesses.map((harness) => harness.shutdown()));
  } finally {
    await Promise.allSettled(harnesses.flatMap((harness) => harness.runs));
    harnesses.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function createShellHarness(params?: {
  spawn?: ProcessSupervisor["spawn"];
  supervisor?: ReturnType<typeof createShellSupervisor>;
}) {
  const messages: string[] = [];
  const overlayHandle = createOverlayHandle();
  const openOverlay = vi.fn((_component: Component) => overlayHandle);
  const closeOverlay = vi.fn();
  const { supervisor, cleanupScope } = params?.supervisor ?? createShellSupervisor(params?.spawn);
  vi.mocked(getProcessSupervisor).mockReturnValue(supervisor);
  const { runLocalShellLine, shutdown } = createLocalShellRunner({
    chatLog: { addSystem: (line) => void messages.push(line) },
    tui: { requestRender: vi.fn() },
    openOverlay,
    closeOverlay,
  });
  const runs: Promise<void>[] = [];
  harnesses.push({ shutdown, runs });
  const getLastSelector = () => {
    const selector = openOverlay.mock.calls.at(-1)?.[0];
    return selector instanceof SearchableSelectList ? selector : null;
  };
  const run = (line: string) => {
    const pending = runLocalShellLine(line);
    runs.push(pending);
    return pending;
  };
  return {
    messages,
    openOverlay,
    overlayHandle,
    closeOverlay,
    supervisor,
    cleanupScope,
    runLocalShellLine: run,
    approve: (line: string, value = "yes") => {
      const pending = run(line);
      getLastSelector()?.onSelect?.({ value, label: value });
      return pending;
    },
    shutdown,
    getLastSelector,
  };
}

function createSettlingSpawn(params: { stdout?: string[]; stderr?: string[]; error?: Error }) {
  return vi.fn<ProcessSupervisor["spawn"]>(async (input) => {
    const activity = { resultSettled: false, lastOutputAtMs: 0 };
    return {
      activity,
      runId: "local-shell-run",
      startedAtMs: 0,
      wait: async () => {
        params.stdout?.forEach((chunk) => input.onStdout?.(chunk));
        params.stderr?.forEach((chunk) => input.onStderr?.(chunk));
        activity.resultSettled = true;
        if (params.error) {
          throw params.error;
        }
        return {
          reason: "exit",
          exitCode: 0,
          exitSignal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        };
      },
      cancel: vi.fn(),
      detachOutput: vi.fn(),
    } satisfies ManagedRun;
  });
}

describe("createLocalShellRunner", () => {
  it("logs denial on subsequent ! attempts without re-prompting", async () => {
    const harness = createShellHarness();

    await harness.approve("!ls", "no");
    await harness.runLocalShellLine("!pwd");

    expect(harness.messages).toEqual(
      expect.arrayContaining([
        "local shell: not enabled",
        "local shell: not enabled for this session",
      ]),
    );
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.spawn).not.toHaveBeenCalled();
    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandle);
  });

  it.each([
    ["full stdout cap", "0".repeat(40_000), "FATAL"],
    ["code point at the tail boundary", "x😀" + "a".repeat(39_994), "tail"],
  ])("preserves stderr after %s", async (_name, stdout, stderr) => {
    const harness = createShellHarness({
      spawn: createSettlingSpawn({ stdout: [stdout], stderr: [stderr] }),
    });
    await harness.approve("!noisy");
    expect(harness.messages).toContain(`[local] ${stderr}`);
    expect(harness.messages.join("\n")).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("refuses to retarget local commands after the working directory is deleted", async () => {
    vi.spyOn(safeCwd, "tryProcessCwd").mockReturnValue(undefined);
    const harness = createShellHarness();

    await harness.approve("!pwd");
    expect(harness.supervisor.spawn).not.toHaveBeenCalled();
    expect(harness.messages).toContain(
      "local shell: working directory was deleted; cd to an existing directory first",
    );
  });

  it.each(["spawn", "wait"])("orders %s failure before the next command", async (failure) => {
    const spawn = createSettlingSpawn({ stdout: ["second\n"] });
    const error = new Error("synthetic failure");
    if (failure === "spawn") {
      spawn.mockRejectedValueOnce(error);
    } else {
      spawn.mockImplementationOnce(createSettlingSpawn({ error }));
    }
    const harness = createShellHarness({ spawn });
    await harness.approve("!echo first");
    await harness.runLocalShellLine("!echo second");

    expect(harness.messages.filter((message) => message.startsWith("[local]"))).toEqual([
      "[local] $ echo first",
      "[local] error: synthetic failure",
      "[local] $ echo second",
      "[local] second",
      "[local] exit 0",
    ]);
  });

  it("fences a pending approval when shutdown begins", async () => {
    const harness = createShellHarness();
    expect(harness.supervisor.acquireScopeCleanup).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      { processTree: "required-all" },
    );
    const run = harness.runLocalShellLine("!echo late");
    const selector = harness.getLastSelector();

    await harness.shutdown();
    selector?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.supervisor.spawn).not.toHaveBeenCalled();
    expect(harness.cleanupScope).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandle);
  });

  it("keeps another TUI instance's settled command scope alive during shutdown", async () => {
    const spawn = createSettlingSpawn({});
    const first = createShellHarness({ spawn });
    const second = createShellHarness({ supervisor: first });

    for (const harness of [first, second]) {
      await harness.approve("!echo alive");
    }

    const firstScope = spawn.mock.calls[0]?.[0].scopeKey;
    const secondScope = spawn.mock.calls[1]?.[0].scopeKey;
    expect(firstScope).toBeDefined();
    expect(secondScope).toBeDefined();
    expect(firstScope).not.toBe(secondScope);
    const shutdown = first.shutdown();
    expect(first.shutdown()).toBe(shutdown);
    await shutdown;

    expect(first.cleanupScope).toHaveBeenCalledExactlyOnceWith(firstScope);
  });
});
