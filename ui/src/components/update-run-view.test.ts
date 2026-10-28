/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateRunRecord as Run } from "../../../src/infra/update-run-record.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createUpdateRunFixture as run } from "../test-helpers/update-run.ts";
import { UpdateRunView } from "./update-run-view.tsx";

type Step = Run["steps"][number];
function makeStep(step: string, status: Step["status"] = "completed", detail?: string): Step {
  return { step, status, detail };
}

const project = (patch: Partial<Run>) => projectUpdateRun(run(patch));

function mount(initial: Partial<Run>) {
  const [current, setRecord] = createSignal(run(initial));
  const [connected, setConnected] = createSignal(true);
  const { container } = mountSolid(() =>
    createComponent(UpdateRunView, {
      get run() {
        return current();
      },
      get connected() {
        return connected();
      },
    }),
  );
  flush();
  const element = container.querySelector<HTMLElement>("openclaw-update-run-view")!;
  const find = (css: string) => element.querySelector<HTMLElement>(css);
  const text = (selector: string) => find(selector)?.textContent;
  const output = () => text(".update-run-view__details");
  const summary = () => text(".update-run-view__diagnostics summary");
  const update = (patch: Partial<Run>) => {
    setRecord(run(patch));
    flush();
  };
  return { element, find, text, output, summary, update, setRecord, setConnected };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("omits native progress for OCM-managed runs", () => {
  const view = project({ target: { kind: "package", installationMethod: "ocm" } });
  expect(view).toMatchObject({ compactLabel: "", phases: [], oracles: [] });
  expect(view.headline).toContain("managed by OCM");
});

it("retains a recorded repair phase after the run has finished", () => {
  const view = project({
    phase: "finished",
    status: "failed",
    steps: [makeStep("repairing", "failed")],
  });
  expect(view.phases.find(({ step }) => step === "repairing")?.status).toBe("failed");
});

it("presents diagnostic receipts as readable details without inventing installation steps", () => {
  const staged = "Revision verified.";
  const backup = "Backup needs 18 GiB.";
  const temporary = "Using the temporary disk.";
  const { element, text, output, summary, setRecord } = mount({
    steps: [
      makeStep("staging", "completed", staged),
      makeStep("snapshot-space-preflight"),
      makeStep("diagnostic:snapshot-space-preflight:8", "completed", backup),
      makeStep("warning:snapshot-space-preflight:2", "completed", temporary),
    ],
  });
  expect(element.querySelectorAll(".update-run-view__step-scroll li")).toHaveLength(2);
  expect(element.textContent).not.toContain("diagnostic:snapshot-space-preflight:8");
  expect(summary()).toContain("Checking space for the recovery backup");
  expect(output()).toContain(backup);
  expect(output()).toContain(temporary);
  expect(text('[data-step="warning:snapshot-space-preflight:2"]')).toContain("Warning:");
  setRecord((record) =>
    run({
      steps: [
        ...record.steps,
        makeStep("updater-runtime-retention", "in_progress"),
        makeStep("validating", "in_progress", "Checking the update."),
      ],
    }),
  );
  flush();
  expect(output()).not.toContain(backup);
  expect(summary()).toContain("Preparing the updater");
  expect(output()).toContain(
    "Keeping a copy of the current updater so it can finish safely while OpenClaw is replaced.",
  );
  for (const [step, details] of [
    ["snapshot-space-preflight", [backup, temporary]],
    ["warning:snapshot-space-preflight:2", [temporary]],
    ["staging", [staged]],
  ] as const) {
    const previousStep = element.querySelector<HTMLDetailsElement>(
      `[data-step="${step}"] details`,
    )!;
    expect(previousStep).not.toBeNull();
    previousStep.querySelector("summary")!.click();
    expect(previousStep.open).toBe(true);
    for (const detail of details) {
      expect(output()).not.toContain(detail);
      expect(previousStep.querySelector("pre")?.textContent).toContain(detail);
    }
    previousStep.querySelector("summary")!.click();
    expect(previousStep.open).toBe(false);
  }
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  setRecord((record) =>
    run({
      steps: [...record.steps, makeStep("install", "in_progress", lines.join("\n"))],
    }),
  );
  flush();
  expect(summary()).toContain("Installing");
  expect(output()).toBe(lines.slice(-80).join("\n"));
});

it("follows run output on opening and updates, preserving scrollback until a new run", async () => {
  const warnings = vi.spyOn(console, "warn");
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const record = run({ steps: [makeStep("build", "in_progress")] });
  const { element, find, setRecord } = mount(record);
  const disclosure = element.querySelector<HTMLDetailsElement>(".update-run-view__step-list")!;
  const list = find(".update-run-view__step-scroll")!;
  const streams = [list, find(".update-run-view__details")!];
  expect(streams[1]!.textContent).toBe("No step details recorded yet.");
  const scrollTo = (expected: number, next: number) => {
    for (const stream of streams) {
      expect(stream.scrollTop).toBe(expected);
      stream.scrollTop = next;
      stream.dispatchEvent(new Event("scroll"));
    }
  };
  const update = async (patch: Partial<Run>) => {
    setRecord({ ...record, ...patch });
    flush();
    await vi.runOnlyPendingTimersAsync();
  };
  for (const stream of streams) {
    Object.defineProperties(stream, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { value: 160 },
    });
  }
  const opened = new Promise<void>((resolve) => {
    disclosure.addEventListener("toggle", () => resolve(), { once: true });
  });
  disclosure.open = true;
  await opened;
  await vi.runOnlyPendingTimersAsync();
  scrollTo(1000, 0);
  await update({ updatedAtMs: record.updatedAtMs + 1 });
  scrollTo(0, 840);
  for (const stream of streams) {
    Object.defineProperty(stream, "scrollHeight", { value: 1200 });
  }
  await update({ updatedAtMs: record.updatedAtMs + 2 });
  scrollTo(1200, 0);
  await update({ runId: "next-update-run" });
  expect(streams.map((stream) => stream.scrollTop)).toEqual([1200, 1200]);
  expect(find(".update-run-view__step-scroll")).toBe(list);
  expect(find(".update-run-view__details")).toBe(streams[1]);
  expect(
    warnings.mock.calls.filter(([message]) => String(message).includes("STRICT_READ_UNTRACKED")),
  ).toEqual([]);
});

it.each([
  [{}, "warn", "service identity unavailable"],
  [{ runningVersion: "new", runningBuildId: "new" }, "warn", "service identity unavailable"],
  [{ runningVersion: "old" }, "fail", "version mismatch"],
  [{ runningVersion: "new", runningBuildId: "old" }, "fail", "build mismatch"],
] as const)("reports %j as %s in the badge and report", (observed, state, detail) => {
  const { find, text } = mount({
    status: "failed",
    phase: "finished",
    reason: "restart-revision-unavailable",
    after: { version: "new", buildId: "new" },
    verification: { versionMatch: false, ...observed },
  });
  expect(find('[data-oracle="version"]')?.getAttribute("data-state")).toBe(state);
  expect(text('[aria-label="Update report"]')).toContain(detail);
});

it("keeps the view mounted across a restart and replaces progress with a visible success report", () => {
  const { element, text, update, setConnected } = mount({ phase: "restarting" });
  const container = element.querySelector(".update-run-view");
  setConnected(false);
  flush();
  expect(text("h3")).toBe("Gateway restarting…");
  expect(element.querySelector('[aria-label="Update report"]')).toBeNull();
  setConnected(true);
  update({
    phase: "verifying",
    verification: { serviceRunning: true, versionMatch: true },
  });
  expect(element.querySelector(".update-run-view")).toBe(container);
  expect(text("h3")).toContain("verifying");
  update({
    phase: "finished",
    status: "succeeded",
    finishedAtMs: 30,
    after: { version: "2026.9.2" },
    verification: {
      serviceRunning: true,
      versionMatch: true,
      channelsReady: true,
      pluginErrors: [],
    },
    steps: [makeStep("staging"), makeStep("verifying")],
  });
  const report = element.querySelector('[aria-label="Update report"]');
  expect(report?.textContent).toContain("✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).");
  expect(report?.textContent).toContain("service running; version verified; channels ready");
  expect(element.querySelectorAll('[data-state="pass"]')).toHaveLength(4);
  expect(element.querySelector('[data-step="repairing"]')).toBeNull();
});

it("preserves early failure phases and renders diagnostic markup as text", () => {
  const failure = '<img src=x onerror="alert(1)"> compilation failed';
  const { element, find, text, output } = mount({
    status: "failed",
    phase: "finished",
    reason: "build-failed",
    steps: [
      makeStep("requested"),
      makeStep("notice:ack"),
      makeStep("staging"),
      makeStep("validating", "failed"),
      makeStep("build", "failed", failure),
    ],
  });
  expect(text('[aria-label="Update report"]')).toContain(
    "Run openclaw triage to diagnose and repair the failed update.",
  );
  expect(output()).toBe(failure);
  const phaseStates = Object.fromEntries(
    [...element.querySelectorAll(".update-run-view__phases [data-status]")].map((phase) => [
      phase.getAttribute("data-step"),
      phase.getAttribute("data-status"),
    ]),
  );
  expect(phaseStates).toMatchObject({
    staging: "completed",
    validating: "failed",
    activating: "skipped",
    finished: "failed",
  });
  expect(element.querySelectorAll(".update-run-view__step-scroll li")).toHaveLength(1);
  expect(element.querySelectorAll('[data-oracle][data-state="warn"]')).toHaveLength(4);
  expect(find("img")).toBeNull();
  expect(find('[data-step="build"]')).toMatchObject({ ariaLabel: "Building OpenClaw: Failed" });
});
