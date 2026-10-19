/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createUpdateRunFixture as run } from "../test-helpers/update-run.ts";
import { UpdateRunView } from "./update-run-view.tsx";

function mount(record: UpdateRunRecord) {
  const [current, setRecord] = createSignal(record);
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
  return { element, setRecord, setConnected };
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

  it.each(["in_progress", "failed"] as const)(
    "preserves a recorded %s repair after activation",
    (status) => {
      const view = projectUpdateRun(
        run({
          phase: status === "in_progress" ? "repairing" : "finished",
          status: status === "in_progress" ? "running" : "failed",
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

  it.each([
    { step: "updater-runtime-retention", detail: undefined },
    { step: "build", detail: undefined },
    {
      step: "install",
      detail: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
    },
  ])(
    "selects active $step details ahead of other steps and bounds the visible tail",
    ({ step, detail }) => {
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
            { step, status: "in_progress", detail },
            { step: "validating", status: "in_progress", detail: "Checking the update." },
            { step: "preflight", status: "completed", detail: "Earlier preflight." },
          ],
        }),
      );
      expect(view.detailStep).toBe(step);
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
    const { element, setRecord } = mount(
      run({
        steps: [
          {
            step: "staging",
            status: "completed",
            detail: "The selected update revision was downloaded and verified.",
          },
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
    setRecord((record) =>
      run({
        steps: [...record.steps, { step: "updater-runtime-retention", status: "in_progress" }],
      }),
    );
    flush();
    expect(element.querySelector(".update-run-view__details")?.textContent).not.toContain(
      "Recovery backup needs 18 GiB.",
    );
    expect(element.querySelector(".update-run-view__diagnostics summary")?.textContent).toContain(
      "Preparing the updater",
    );
    expect(element.querySelector(".update-run-view__details")?.textContent).toContain(
      "Keeping a copy of the current updater so it can finish safely while OpenClaw is replaced.",
    );
    for (const [step, details] of [
      ["snapshot-space-preflight", ["Recovery backup needs 18 GiB.", "Using the temporary disk"]],
      ["warning:snapshot-space-preflight:2", ["Using the temporary disk"]],
      ["staging", ["The selected update revision was downloaded and verified."]],
    ] as const) {
      const previousStep = element.querySelector<HTMLDetailsElement>(
        `[data-step="${step}"] details`,
      )!;
      expect(previousStep).not.toBeNull();
      previousStep.querySelector("summary")!.click();
      expect(previousStep.open).toBe(true);
      for (const detail of details) {
        expect(element.querySelector(".update-run-view__details")?.textContent).not.toContain(
          detail,
        );
        expect(previousStep.querySelector("pre")?.textContent).toContain(detail);
      }
      previousStep.querySelector("summary")!.click();
      expect(previousStep.open).toBe(false);
    }
  });

  it("follows run output on opening and updates, preserving scrollback until a new run", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const record = run({ steps: [{ step: "build", status: "in_progress" }] });
    const { element, setRecord } = mount(record);
    const disclosure = element.querySelector<HTMLDetailsElement>(".update-run-view__step-list")!;
    const list = element.querySelector<HTMLElement>(".update-run-view__step-scroll")!;
    const streams = [list, element.querySelector<HTMLElement>(".update-run-view__details")!];
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
    for (const stream of streams) {
      expect(stream.scrollTop).toBe(1000);
      stream.scrollTop = 0;
      stream.dispatchEvent(new Event("scroll"));
    }
    setRecord({ ...record, updatedAtMs: record.updatedAtMs + 1 });
    flush();
    await vi.runOnlyPendingTimersAsync();
    for (const stream of streams) {
      expect(stream.scrollTop).toBe(0);
      stream.scrollTop = 840;
      stream.dispatchEvent(new Event("scroll"));
      Object.defineProperty(stream, "scrollHeight", { value: 1200 });
    }
    setRecord({ ...record, updatedAtMs: record.updatedAtMs + 2 });
    flush();
    await vi.runOnlyPendingTimersAsync();
    for (const stream of streams) {
      expect(stream.scrollTop).toBe(1200);
      stream.scrollTop = 0;
      stream.dispatchEvent(new Event("scroll"));
    }
    setRecord({ ...record, runId: "next-update-run" });
    flush();
    await vi.runOnlyPendingTimersAsync();
    for (const stream of streams) {
      expect(stream.scrollTop).toBe(1200);
    }
    expect(element.querySelector(".update-run-view__step-scroll")).toBe(list);
    expect(element.querySelector(".update-run-view__details")).toBe(streams[1]);
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
    ({ observed, state, detail }) => {
      const { element } = mount(
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

  it("keeps the view mounted across a restart and replaces progress with a visible success report", () => {
    const { element, setRecord, setConnected } = mount(run({ phase: "restarting" }));
    const container = element.querySelector(".update-run-view");
    setConnected(false);
    flush();
    expect(element.querySelector("h3")?.textContent).toBe("Gateway restarting…");
    expect(element.querySelector('[aria-label="Update report"]')).toBeNull();
    setConnected(true);
    setRecord(
      run({
        phase: "verifying",
        verification: { serviceRunning: true, versionMatch: true },
      }),
    );
    flush();
    expect(element.querySelector(".update-run-view")).toBe(container);
    expect(element.querySelector("h3")?.textContent).toContain("verifying");
    setRecord(
      run({
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
      }),
    );
    flush();
    const report = element.querySelector('[aria-label="Update report"]');
    expect(report?.textContent).toContain("✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).");
    expect(report?.textContent).toContain("service running; version verified; channels ready");
    expect(element.querySelectorAll('[data-state="pass"]')).toHaveLength(4);
    expect(element.querySelector('[data-step="repairing"]')).toBeNull();
  });

  it("shows failure details and report text without interpreting diagnostic markup", () => {
    const { element } = mount(
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
