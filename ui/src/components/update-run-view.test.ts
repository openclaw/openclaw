/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunPhase, UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import { createUpdateRunFixture as run } from "../test-helpers/update-run.ts";
import "./update-run-view.ts";

type RunViewElement = HTMLElement & {
  run: UpdateRunRecord | null;
  connected: boolean;
  updateComplete: Promise<boolean>;
};

async function mount(record: UpdateRunRecord) {
  const element = document.createElement("openclaw-update-run-view") as RunViewElement;
  element.run = record;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("update run projection", () => {
  it.each(["running", "succeeded", "skipped", "failed"] as const)(
    "keeps native phase and verification claims out of an OCM %s result",
    (status) => {
      const view = projectUpdateRun(
        run({
          status,
          phase: status === "running" ? "requested" : "finished",
          target: { kind: "package", installationMethod: "ocm" },
        }),
      );
      expect(view.compactLabel).toBe("");
      expect(view.phases).toEqual([]);
      expect(view.oracles).toEqual([]);
      if (status === "running") {
        expect(view.headline).toContain("managed by OCM");
      }
    },
  );

  it("keeps recorded failure and skipped phases distinct when a run ends early", () => {
    const view = projectUpdateRun(
      run({
        phase: "finished",
        status: "failed",
        reason: "build-failed",
        steps: [
          { step: "requested", status: "completed" },
          { step: "notice:ack", status: "completed" },
          { step: "staging", status: "completed" },
          { step: "validating", status: "failed" },
          { step: "build", status: "failed", detail: "Build failed before activation." },
        ],
      }),
    );
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

  it.each<UpdateRunPhase>(["requested", "staging", "validating", "verifying", "finished"])(
    "hides unused repair during %s",
    (phase) => {
      const view = projectUpdateRun(
        run({ phase, status: phase === "finished" ? "succeeded" : "running" }),
      );
      expect(view.phases.some(({ step }) => step === "repairing")).toBe(false);
    },
  );

  it.each(["in_progress", "completed", "failed", "skipped"] as const)(
    "preserves a recorded %s repair after activation",
    (status) => {
      const view = projectUpdateRun(
        run({
          phase: status === "in_progress" ? "repairing" : "finished",
          status:
            status === "in_progress" ? "running" : status === "completed" ? "succeeded" : "failed",
          steps: [
            { step: "activating", status: "completed" },
            { step: "restarting", status: "completed" },
            { step: "verifying", status: "failed" },
            { step: "repairing", status, startedAtMs: 10 },
          ],
        }),
      );
      expect(view.phases.find(({ step }) => step === "repairing")?.status).toBe(status);
      expect(view.phases.find(({ step }) => step === "activating")?.status).toBe("completed");
      expect(view.phases.find(({ step }) => step === "verifying")?.status).toBe("failed");
    },
  );

  it.each(["updater-runtime-retention", "build"])(
    "selects the active %s before its first diagnostic instead of the previous step",
    (step) => {
      const view = projectUpdateRun(
        run({
          phase: "validating",
          steps: [
            { step: "snapshot-space-preflight", status: "completed" },
            {
              step: "diagnostic:snapshot-space-preflight:8",
              status: "completed",
              detail: "Recovery backup needs 18 GiB.",
            },
            { step, status: "in_progress" },
            { step: "validating", status: "in_progress", detail: "Checking the update." },
          ],
        }),
      );
      expect(view.detailStep).toBe(step);
      expect(view.details).toBe("");
    },
  );

  it("selects live details ahead of a later completed step and bounds the visible tail", () => {
    const view = projectUpdateRun(
      run({
        steps: [
          {
            step: "install",
            status: "in_progress",
            detail: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
          },
          { step: "preflight", status: "completed", detail: "Earlier preflight." },
        ],
      }),
    );
    expect(view.detailStep).toBe("install");
    expect(view.details.split("\n")).toHaveLength(80);
    expect(view.details.startsWith("line 20\n")).toBe(true);
    expect(view.details.endsWith("line 99")).toBe(true);
  });
});

describe("update run view", () => {
  it("registers its own English step labels and retention guidance on first load", async () => {
    const element = await mount(
      run({ steps: [{ step: "updater-runtime-retention", status: "in_progress" }] }),
    );
    expect(element.querySelector(".update-run-view__diagnostics summary")?.textContent).toContain(
      "Preparing the updater",
    );
    expect(element.querySelector(".update-run-view__details")?.textContent).toContain(
      "Keeping a copy of the current updater so it can finish safely while OpenClaw is replaced.",
    );
  });

  it("presents diagnostic receipts as readable details without inventing installation steps", async () => {
    const element = await mount(
      run({
        steps: [
          { step: "snapshot-space-preflight", status: "completed" },
          {
            step: "diagnostic:snapshot-space-preflight:8",
            status: "completed",
            detail: "Recovery backup needs 18 GiB.",
          },
          {
            step: "warning:snapshot-space-preflight:2",
            status: "completed",
            detail: "Using the temporary disk for the recovery backup.",
          },
        ],
      }),
    );
    expect(element.querySelectorAll(".update-run-view__step-scroll li")).toHaveLength(2);
    expect(element.textContent).not.toContain("diagnostic:snapshot-space-preflight:8");
    expect(element.querySelector(".update-run-view__diagnostics summary")?.textContent).toContain(
      "Checking space for the recovery backup",
    );
    expect(element.querySelector(".update-run-view__details")?.textContent).toContain(
      "Recovery backup needs 18 GiB.",
    );
    expect(element.querySelector(".update-run-view__details")?.textContent).toContain(
      "Using the temporary disk",
    );
    expect(
      element.querySelector('[data-step="warning:snapshot-space-preflight:2"]')?.textContent,
    ).toContain("Warning:");
    element.run = run({
      steps: [...element.run!.steps, { step: "updater-runtime-retention", status: "in_progress" }],
    });
    await element.updateComplete;
    expect(element.querySelector(".update-run-view__details")?.textContent).not.toContain(
      "Recovery backup needs 18 GiB.",
    );
    const previousStep = element.querySelector<HTMLDetailsElement>(
      '[data-step="snapshot-space-preflight"] details',
    )!;
    previousStep.querySelector("summary")!.click();
    expect(previousStep.open).toBe(true);
    expect(previousStep.textContent).toContain("Recovery backup needs 18 GiB.");
    expect(previousStep.textContent).toContain("Using the temporary disk");
    previousStep.querySelector("summary")!.click();
    expect(previousStep.open).toBe(false);
  });

  it.each([
    {
      step: "warning:disk-space-preflight:2",
      detail: "The recovery backup will use temporary storage.",
    },
    { step: "staging", detail: "The selected update revision was downloaded and verified." },
  ])(
    "keeps completed $step details accessible after a new operation begins",
    async ({ step, detail }) => {
      const element = await mount(
        run({
          phase: "validating",
          steps: [
            { step, status: "completed", detail },
            { step: "updater-runtime-retention", status: "in_progress" },
          ],
        }),
      );
      expect(element.querySelector(".update-run-view__details")?.textContent).not.toContain(detail);
      const previousStep = element.querySelector<HTMLDetailsElement>(
        `[data-step="${step}"] details`,
      )!;
      expect(previousStep).not.toBeNull();
      previousStep.querySelector("summary")!.click();
      expect(previousStep.open).toBe(true);
      expect(previousStep.querySelector("pre")?.textContent).toContain(detail);
      previousStep.querySelector("summary")!.click();
      expect(previousStep.open).toBe(false);
    },
  );

  it("follows installation progress on opening and updates but preserves scrollback", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const record = run({ steps: [{ step: "build", status: "in_progress" }] });
    const element = await mount(record);
    const disclosure = element.querySelector<HTMLDetailsElement>(".update-run-view__step-list")!;
    const list = element.querySelector<HTMLElement>(".update-run-view__step-scroll")!;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { value: 160 },
    });
    const opened = new Promise<void>((resolve) => {
      disclosure.addEventListener("toggle", () => resolve(), { once: true });
    });
    disclosure.open = true;
    await opened;
    await vi.runOnlyPendingTimersAsync();
    expect(list.scrollTop).toBe(1000);

    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
    element.run = { ...record, updatedAtMs: record.updatedAtMs + 1 };
    await element.updateComplete;
    await vi.runOnlyPendingTimersAsync();
    expect(list.scrollTop).toBe(0);

    list.scrollTop = 840;
    list.dispatchEvent(new Event("scroll"));
    Object.defineProperty(list, "scrollHeight", { value: 1200 });
    element.run = { ...record, updatedAtMs: record.updatedAtMs + 2 };
    await element.updateComplete;
    await vi.runOnlyPendingTimersAsync();
    expect(list.scrollTop).toBe(1200);
  });

  it.each([
    {
      label: "missing identity",
      observed: {},
      state: "warn",
      detail: "service identity unavailable",
    },
    {
      label: "matching values without a verified identity",
      observed: { runningVersion: "2026.9.2", runningBuildId: "new-build" },
      state: "warn",
      detail: "service identity unavailable",
    },
    {
      label: "a different version",
      observed: { runningVersion: "2026.9.1" },
      state: "fail",
      detail: "version mismatch",
    },
    {
      label: "a different build",
      observed: { runningVersion: "2026.9.2", runningBuildId: "old-build" },
      state: "fail",
      detail: "build mismatch",
    },
  ])(
    "reports $label consistently in the verification badge and report",
    async ({ observed, state, detail }) => {
      const element = await mount(
        run({
          status: "failed",
          phase: "finished",
          reason: "restart-revision-unavailable",
          after: { version: "2026.9.2", buildId: "new-build" },
          verification: { versionMatch: false, ...observed },
        }),
      );
      expect(element.querySelector('[data-oracle="version"]')?.getAttribute("data-state")).toBe(
        state,
      );
      expect(element.querySelector('[aria-label="Update report"]')?.textContent).toContain(detail);
    },
  );

  it("keeps the view mounted across a restart and replaces progress with a visible success report", async () => {
    const element = await mount(run({ phase: "restarting" }));
    const container = element.querySelector(".update-run-view");
    element.connected = false;
    await element.updateComplete;
    expect(element.querySelector("h3")?.textContent).toBe("Gateway restarting…");
    expect(element.querySelector('[aria-label="Update report"]')).toBeNull();
    element.connected = true;
    element.run = run({
      phase: "verifying",
      verification: { serviceRunning: true, versionMatch: true },
    });
    await element.updateComplete;
    expect(element.querySelector(".update-run-view")).toBe(container);
    expect(element.querySelector("h3")?.textContent).toContain("verifying");
    element.run = run({
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
      steps: [
        { step: "staging", status: "completed" },
        { step: "verifying", status: "completed" },
      ],
    });
    await element.updateComplete;
    const report = element.querySelector('[aria-label="Update report"]');
    expect(report?.textContent).toContain("✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).");
    expect(report?.textContent).toContain("service running; version verified; channels ready");
    expect(element.querySelectorAll('[data-state="pass"]')).toHaveLength(4);
    expect(element.querySelector('[data-step="repairing"]')).toBeNull();
  });

  it("shows failure details and report text without interpreting diagnostic markup", async () => {
    const element = await mount(
      run({
        status: "failed",
        phase: "finished",
        reason: "build-failed",
        steps: [
          {
            step: "build",
            status: "failed",
            detail: '<img src=x onerror="alert(1)"> compilation failed',
          },
        ],
      }),
    );
    expect(element.querySelector('[aria-label="Update report"]')?.textContent).toContain(
      "Run openclaw triage to diagnose and repair the failed update.",
    );
    expect(element.querySelector(".update-run-view__details")?.textContent).toContain(
      '<img src=x onerror="alert(1)">',
    );
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector('[data-step="build"]')?.getAttribute("aria-label")).toBe(
      "Building OpenClaw: Failed",
    );
  });
});
