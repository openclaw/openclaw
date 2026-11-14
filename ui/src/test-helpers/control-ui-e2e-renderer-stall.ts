import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { CDPSession, Page } from "playwright";

const RENDERER_STALL_BUDGET_MS = 3_000;
const RENDERER_STALL_SAMPLE_MS = 500;
const RENDERER_STALL_FRAME_LIMIT = 16;
const controlUiE2eRendererStallProbes = new WeakMap<
  Page,
  Promise<{
    session: CDPSession;
    scripts: Map<string, string>;
    captureStack: boolean;
    cleanup(): void;
  } | null>
>();

type RendererStallFrame = { functionName: string; script: string; line: number; column: number };
type RendererStall = {
  /** Renderer main-thread time spent during the sample window, by kind. */
  busyMs: { task: number; script: number; layout: number; style: number } | null;
  sampleMs: number;
  /** Paused JavaScript frames (1-based positions); null when no script was running. */
  stack: RendererStallFrame[] | null;
};

/** Runs in the page: keeps the last script-attributed frames that blocked for a second or more. */
function recordLongAnimationFrames() {
  type ScriptTiming = {
    duration: number;
    forcedStyleAndLayoutDuration: number;
    invoker: string;
    invokerType: string;
    sourceCharPosition: number;
    sourceFunctionName: string;
    sourceURL: string;
  };
  type LongFrame = PerformanceEntry & { blockingDuration: number; scripts: ScriptTiming[] };
  const frames: unknown[] = [];
  // Only bundle paths reach CI logs; origins, query strings and blob/data URLs stay out.
  const pathOf = (url: string) => {
    try {
      const parsed = new URL(url);
      return /^https?:$/u.test(parsed.protocol) ? parsed.pathname : "";
    } catch {
      return "";
    }
  };
  // Listener invokers name their element by id or src; keep only the tag and event.
  const invokerOf = (script: ScriptTiming) => {
    if (script.invokerType === "event-listener") {
      const listener = /^([A-Za-z][\w-]*)\b.*\.(on[\w-]+)$/u.exec(script.invoker);
      return listener ? `${listener[1]}.${listener[2]}` : "";
    }
    if (script.invokerType === "classic-script" || script.invokerType === "module-script") {
      return pathOf(script.invoker);
    }
    return /^[A-Za-z]+(?:[.:][A-Za-z]+)*$/u.test(script.invoker) ? script.invoker : "";
  };
  const record = (entries: PerformanceEntryList) => {
    for (const entry of entries as LongFrame[]) {
      if (entry.duration < 1_000) {
        continue;
      }
      frames.push({
        startMs: Math.round(entry.startTime),
        durationMs: Math.round(entry.duration),
        blockingMs: Math.round(entry.blockingDuration),
        scripts: entry.scripts
          .toSorted((left, right) => right.duration - left.duration)
          .slice(0, 4)
          .map((script) => ({
            invokerType: script.invokerType,
            invoker: invokerOf(script),
            functionName: script.sourceFunctionName,
            script: pathOf(script.sourceURL),
            charPosition: script.sourceCharPosition,
            durationMs: Math.round(script.duration),
            forcedLayoutMs: Math.round(script.forcedStyleAndLayoutDuration),
          })),
      });
      frames.splice(0, Math.max(0, frames.length - 8));
    }
  };
  try {
    const observer = new PerformanceObserver((list) => record(list.getEntries()));
    observer.observe({ type: "long-animation-frame", buffered: true });
    // Failure reads flush entries whose observer task has not run yet.
    Reflect.set(window, "__OPENCLAW_CONTROL_UI_E2E_LONG_FRAMES__", () => {
      record(observer.takeRecords());
      return frames;
    });
  } catch {
    // Browsers without Long Animation Frames publish no ring.
  }
}

/**
 * Install passive stall evidence before navigation and the test's own CDP
 * sessions. Full stacks are opt-in: enabling the debugger slows every app boot.
 * A never-ending task still serves Performance metrics, but Debugger.enable
 * waits for it, so proof captures must arm the debugger before the stall.
 */
export async function installControlUiE2eRendererStallProbe(page: Page): Promise<void> {
  if (controlUiE2eRendererStallProbes.has(page)) {
    return;
  }
  const probe = (async () => {
    try {
      await page.addInitScript(recordLongAnimationFrames);
      const session = await page.context().newCDPSession(page);
      const captureStack = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
      const scripts = new Map<string, string>();
      const parsed = ({ scriptId, url }: { scriptId: string; url: string }) => {
        const pathname = stallScriptPath(url);
        if (pathname && scripts.size < 256) {
          scripts.set(scriptId, pathname);
        }
      };
      if (captureStack) {
        session.on("Debugger.scriptParsed", parsed);
        // Collected scripts stay collectable, so heap budgets measure the app alone.
        await session.send("Debugger.enable", { maxScriptsCacheSize: 0 });
        // Inactive breakpoints skip `debugger` statements; explicit pauses still stop.
        await session.send("Debugger.setBreakpointsActive", { active: false });
      }
      await session.send("Performance.enable");
      return {
        session,
        scripts,
        captureStack,
        cleanup: () => session.off("Debugger.scriptParsed", parsed),
      };
    } catch {
      // Evidence is best effort: closed pages, non-Chromium contexts, and test
      // doubles run without a probe.
      return null;
    }
  })();
  controlUiE2eRendererStallProbes.set(page, probe);
  await probe;
}

function stallScriptPath(url: string) {
  try {
    const parsed = new URL(url);
    return /^https?:$/u.test(parsed.protocol) &&
      /^\/assets\/[A-Za-z0-9_.-]+\.js$/u.test(parsed.pathname)
      ? parsed.pathname
      : "";
  } catch {
    return "";
  }
}

/** Read the work holding a renderer that missed the failure-read deadline, then release it. */
export async function captureControlUiE2eRendererStall(
  page: Page,
  rendererRead: "completed" | "rejected" | "deadline",
): Promise<RendererStall | null> {
  if (rendererRead !== "deadline") {
    return null;
  }
  const probe = controlUiE2eRendererStallProbes.get(page);
  controlUiE2eRendererStallProbes.delete(page);
  const deadline = performance.now() + RENDERER_STALL_BUDGET_MS;
  const remaining = () => Math.max(1, deadline - performance.now());
  const armed = probe ? await withTimeout(probe, remaining()).catch(() => null) : null;
  if (!armed) {
    return null;
  }
  const { session, scripts } = armed;
  const stall: RendererStall = { busyMs: null, sampleMs: 0, stack: null };
  let pauseRequested = false;
  try {
    const sample = async () => {
      const { metrics } = await withTimeout(
        session.send("Performance.getMetrics"),
        Math.min(RENDERER_STALL_SAMPLE_MS, remaining() / 2),
      );
      return (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
    };
    try {
      const before = await sample();
      // Leave at least half of the remaining budget for the stack and cleanup.
      stall.sampleMs = Math.round(Math.min(RENDERER_STALL_SAMPLE_MS, remaining() / 2));
      await new Promise((resolve) => {
        setTimeout(resolve, stall.sampleMs);
      });
      const after = await sample();
      const busy = (name: string) => Math.round((after(name) - before(name)) * 1_000);
      stall.busyMs = {
        task: busy("TaskDuration"),
        script: busy("ScriptDuration"),
        layout: busy("LayoutDuration"),
        style: busy("RecalcStyleDuration"),
      };
    } catch {
      // A native renderer stall can block metrics; still try the armed debugger.
    }
    if (!armed.captureStack) {
      return stall;
    }
    const paused = new Promise<void>((resolve) => {
      session.on("Debugger.paused", ({ callFrames }) => {
        try {
          if (stall.stack !== null) {
            return;
          }
          stall.stack = callFrames.slice(0, RENDERER_STALL_FRAME_LIMIT).map((frame) => ({
            functionName: frame.functionName || "(anonymous)",
            script: stallScriptPath(frame.url) || scripts.get(frame.location.scriptId) || "",
            line: frame.location.lineNumber + 1,
            column: (frame.location.columnNumber ?? 0) + 1,
          }));
        } finally {
          void session.send("Debugger.resume").catch(() => {});
          resolve();
        }
      });
    });
    pauseRequested = true;
    await withTimeout(session.send("Debugger.pause"), remaining());
    await withTimeout(paused, remaining());
  } catch {
    // Missing samples stay null: a stack timeout means no script was running.
  } finally {
    if (pauseRequested) {
      void session.send("Debugger.resume").catch(() => {});
    }
    // Detaching also retires a pause that a native stall left pending.
    await withTimeout(session.detach(), remaining()).catch(() => {});
    armed.cleanup();
    scripts.clear();
  }
  return stall;
}
