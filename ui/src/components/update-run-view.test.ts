/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateRunRecord as Run } from "../../../src/infra/update-run-record.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
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
  cleanupSolid();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["running", "skipped"] as const)("omits native progress for OCM %s", (status) => {
  const view = project({
    status,
    phase: status === "running" ? "requested" : "finished",
    target: { kind: "package", installationMethod: "ocm" },
  });
  expect(view).toMatchObject({ compactLabel: "", phases: [], oracles: [] });
  if (status === "running") {
    expect(view.headline).toContain("managed by OCM");
  }
});

it("keeps recorded failure and skipped phases distinct when a run ends early", () => {
  const failure = "Build failed before activation.";
  const view = project({
    phase: "finished",
    status: "failed",
    reason: "build-failed",
    steps: [
      makeStep("requested"),
      makeStep("notice:ack"),
      makeStep("staging"),
      makeStep("validating", "failed"),
      makeStep("build", "failed", failure),
    ],
  });
  expect(view.phases.map(({ step, status }) => [step, status])).toEqual([
    ["requested", "completed"],
    ["staging", "completed"],
    ["validating", "failed"],
    ["activating", "skipped"],
    ["restarting", "skipped"],
    ["verifying", "skipped"],
    ["finished", "failed"],
  ]);
  expect(view.steps).toEqual([{ step: "build", status: "failed", detail: failure }]);
  expect(view.details).toBe(failure);
  expect(view.oracles.every((oracle) => oracle.state === "warn")).toBe(true);
});

it.each(["in_progress", "failed"] as const)("preserves %s repair after activation", (status) => {
  const view = project({
    phase: status === "in_progress" ? "repairing" : "finished",
    status: status === "in_progress" ? "running" : "failed",
    steps: [
      makeStep("activating"),
      makeStep("restarting"),
      makeStep("verifying", "failed"),
      { ...makeStep("repairing", status), startedAtMs: 10 },
    ],
  });
  const phases = Object.fromEntries(view.phases.map(({ step, status: state }) => [step, state]));
  expect(phases).toMatchObject({
    repairing: status,
    activating: "completed",
    verifying: "failed",
  });
});

it.each([
  { step: "updater-runtime-retention", detail: undefined },
  { step: "build", detail: undefined },
  {
    step: "install",
    detail: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
  },
])("selects active $step details and bounds the tail", ({ step: activeStep, detail }) => {
  const view = project({
    phase: "validating",
    steps: [
      makeStep("snapshot-space-preflight"),
      makeStep("diagnostic:snapshot-space-preflight:8", "completed", "Backup details."),
      makeStep(activeStep, "in_progress", detail),
      makeStep("validating", "in_progress", "Checking the update."),
      makeStep("preflight", "completed", "Earlier preflight."),
    ],
  });
  expect(view.detailStep).toBe(activeStep);
  const tail = Array.from({ length: 80 }, (_, i) => `line ${i + 20}`).join("\n");
  expect(view.details).toBe(detail ? tail : "");
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
      steps: [...record.steps, makeStep("updater-runtime-retention", "in_progress")],
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
});

it("follows run output on opening and updates, preserving scrollback until a new run", async () => {
  const warnings = vi.spyOn(console, "warn");
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const record = run({ steps: [makeStep("build", "in_progress")] });
  const { element, find, setRecord } = mount(record);
  const disclosure = element.querySelector<HTMLDetailsElement>(".update-run-view__step-list")!;
  const list = find(".update-run-view__step-scroll")!;
  const streams = [list, find(".update-run-view__details")!];
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

it("shows failure details and report text without interpreting diagnostic markup", () => {
  const { find, text, output } = mount({
    status: "failed",
    phase: "finished",
    reason: "build-failed",
    steps: [makeStep("build", "failed", '<img src=x onerror="alert(1)"> compilation failed')],
  });
  expect(text('[aria-label="Update report"]')).toContain(
    "Run openclaw triage to diagnose and repair the failed update.",
  );
  expect(output()).toContain('<img src=x onerror="alert(1)">');
  expect(find("img")).toBeNull();
  expect(find('[data-step="build"]')).toMatchObject({ ariaLabel: "Building OpenClaw: Failed" });
});
