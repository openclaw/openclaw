/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunRecord, UpdateRunStep } from "../../../src/infra/update-run-record.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createUpdateRunFixture as run } from "../test-helpers/update-run.ts";
import { UpdateRunView } from "./update-run-view.tsx";

function makeStep(
  step: string,
  status: UpdateRunStep["status"] = "completed",
  detail?: string,
): UpdateRunStep {
  return { step, status, detail };
}

const project = (patch: Partial<UpdateRunRecord>) => projectUpdateRun(run(patch));

function mount(initial: Partial<UpdateRunRecord>) {
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
  const text = (selector: string) => element.querySelector(selector)?.textContent;
  const update = (patch: Partial<UpdateRunRecord>) => {
    setRecord(run(patch));
    flush();
  };
  return { element, text, update, setRecord, setConnected };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("update run projection", () => {
  it.each(["running", "skipped"] as const)(
    "keeps native phase and verification claims out of an OCM %s result",
    (status) => {
      const view = project({
        status,
        phase: status === "running" ? "requested" : "finished",
        target: { kind: "package", installationMethod: "ocm" },
      });
      expect(view.compactLabel).toBe("");
      expect(view.phases).toEqual([]);
      expect(view.oracles).toEqual([]);
      if (status === "running") {
        expect(view.headline).toContain("managed by OCM");
      }
    },
  );

  it("keeps recorded failure and skipped phases distinct when a run ends early", () => {
    const view = project({
      phase: "finished",
      status: "failed",
      reason: "build-failed",
      steps: [
        makeStep("requested"),
        makeStep("notice:ack"),
        makeStep("staging"),
        makeStep("validating", "failed"),
        makeStep("build", "failed", "Build failed before activation."),
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
    expect(view.steps).toEqual([
      { step: "build", status: "failed", detail: "Build failed before activation." },
    ]);
    expect(view.details).toBe("Build failed before activation.");
    expect(view.oracles.every((oracle) => oracle.state === "warn")).toBe(true);
  });

  it.each(["in_progress", "failed"] as const)(
    "preserves a recorded %s repair after activation",
    (status) => {
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
      expect(view.phases.find(({ step }) => step === "repairing")?.status).toBe(status);
      expect(view.phases.find(({ step }) => step === "activating")?.status).toBe("completed");
      expect(view.phases.find(({ step }) => step === "verifying")?.status).toBe("failed");
    },
  );

  it.each([
    { step: "updater-runtime-retention", detail: undefined },
    { step: "build", detail: undefined },
    {
      step: "install",
      detail: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
    },
  ])(
    "selects active $step details ahead of other steps and bounds the visible tail",
    ({ step: activeStep, detail }) => {
      const view = project({
        phase: "validating",
        steps: [
          makeStep("snapshot-space-preflight"),
          makeStep(
            "diagnostic:snapshot-space-preflight:8",
            "completed",
            "Recovery backup needs 18 GiB.",
          ),
          makeStep(activeStep, "in_progress", detail),
          makeStep("validating", "in_progress", "Checking the update."),
          makeStep("preflight", "completed", "Earlier preflight."),
        ],
      });
      expect(view.detailStep).toBe(activeStep);
      if (detail) {
        expect(view.details.split("\n")).toHaveLength(80);
        expect(view.details.startsWith("line 20\n")).toBe(true);
        expect(view.details.endsWith("line 99")).toBe(true);
      } else {
        expect(view.details).toBe("");
      }
    },
  );
});

describe("update run view", () => {
  it("presents diagnostic receipts as readable details without inventing installation steps", () => {
    const staged = "The selected update revision was downloaded and verified.";
    const backup = "Recovery backup needs 18 GiB.";
    const temporary = "Using the temporary disk for the recovery backup.";
    const { element, text, setRecord } = mount({
      steps: [
        makeStep("staging", "completed", staged),
        makeStep("snapshot-space-preflight"),
        makeStep("diagnostic:snapshot-space-preflight:8", "completed", backup),
        makeStep("warning:snapshot-space-preflight:2", "completed", temporary),
      ],
    });
    expect(element.querySelectorAll(".update-run-view__step-scroll li")).toHaveLength(2);
    expect(element.textContent).not.toContain("diagnostic:snapshot-space-preflight:8");
    expect(text(".update-run-view__diagnostics summary")).toContain(
      "Checking space for the recovery backup",
    );
    expect(text(".update-run-view__details")).toContain(backup);
    expect(text(".update-run-view__details")).toContain("Using the temporary disk");
    expect(text('[data-step="warning:snapshot-space-preflight:2"]')).toContain("Warning:");
    setRecord((record) =>
      run({
        steps: [...record.steps, makeStep("updater-runtime-retention", "in_progress")],
      }),
    );
    flush();
    expect(text(".update-run-view__details")).not.toContain(backup);
    expect(text(".update-run-view__diagnostics summary")).toContain("Preparing the updater");
    expect(text(".update-run-view__details")).toContain(
      "Keeping a copy of the current updater so it can finish safely while OpenClaw is replaced.",
    );
    for (const [step, details] of [
      ["snapshot-space-preflight", [backup, "Using the temporary disk"]],
      ["warning:snapshot-space-preflight:2", ["Using the temporary disk"]],
      ["staging", [staged]],
    ] as const) {
      const previousStep = element.querySelector<HTMLDetailsElement>(
        `[data-step="${step}"] details`,
      )!;
      expect(previousStep).not.toBeNull();
      previousStep.querySelector("summary")!.click();
      expect(previousStep.open).toBe(true);
      for (const detail of details) {
        expect(text(".update-run-view__details")).not.toContain(detail);
        expect(previousStep.querySelector("pre")?.textContent).toContain(detail);
      }
      previousStep.querySelector("summary")!.click();
      expect(previousStep.open).toBe(false);
    }
  });

  it("follows run output on opening and updates, preserving scrollback until a new run", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const record = run({ steps: [makeStep("build", "in_progress")] });
    const { element, setRecord } = mount(record);
    const disclosure = element.querySelector<HTMLDetailsElement>(".update-run-view__step-list")!;
    const list = element.querySelector<HTMLElement>(".update-run-view__step-scroll")!;
    const streams = [list, element.querySelector<HTMLElement>(".update-run-view__details")!];
    const scrollTo = (expected: number, next: number) => {
      for (const stream of streams) {
        expect(stream.scrollTop).toBe(expected);
        stream.scrollTop = next;
        stream.dispatchEvent(new Event("scroll"));
      }
    };
    const update = async (patch: Partial<UpdateRunRecord>) => {
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
    for (const stream of streams) {
      expect(stream.scrollTop).toBe(1200);
    }
    expect(element.querySelector(".update-run-view__step-scroll")).toBe(list);
    expect(element.querySelector(".update-run-view__details")).toBe(streams[1]);
  });

  it.each([
    ["missing identity", {}, "warn", "service identity unavailable"],
    [
      "matching values without a verified identity",
      { runningVersion: "2026.9.2", runningBuildId: "new-build" },
      "warn",
      "service identity unavailable",
    ],
    ["a different version", { runningVersion: "2026.9.1" }, "fail", "version mismatch"],
    [
      "a different build",
      { runningVersion: "2026.9.2", runningBuildId: "old-build" },
      "fail",
      "build mismatch",
    ],
  ] as const)(
    "reports %s consistently in the verification badge and report",
    (_label, observed, state, detail) => {
      const { element, text } = mount({
        status: "failed",
        phase: "finished",
        reason: "restart-revision-unavailable",
        after: { version: "2026.9.2", buildId: "new-build" },
        verification: { versionMatch: false, ...observed },
      });
      expect(element.querySelector('[data-oracle="version"]')?.getAttribute("data-state")).toBe(
        state,
      );
      expect(text('[aria-label="Update report"]')).toContain(detail);
    },
  );

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
    const { element, text } = mount({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
      steps: [makeStep("build", "failed", '<img src=x onerror="alert(1)"> compilation failed')],
    });
    expect(text('[aria-label="Update report"]')).toContain(
      "Run openclaw triage to diagnose and repair the failed update.",
    );
    expect(text(".update-run-view__details")).toContain('<img src=x onerror="alert(1)">');
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector('[data-step="build"]')?.getAttribute("aria-label")).toBe(
      "Building OpenClaw: Failed",
    );
  });
});
