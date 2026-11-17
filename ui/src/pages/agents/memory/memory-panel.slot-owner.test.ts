/* @vitest-environment jsdom */

import { getByRole } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createPage, STATUS } from "./memory-panel.test-support.ts";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";

const restoreTranslations = installDreamingViewTestTranslations();
afterAll(restoreTranslations);
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("a memory slot owner that reports its own dreaming", () => {
  const OWNER_CONFIG = { plugins: { slots: { memory: "acme-memory" } } };
  const phase = (enabled: boolean, managedCronPresent: boolean) => ({
    enabled,
    managedCronPresent,
    cron: "",
  });
  const ownerStatus = (dreaming: Record<string, unknown>) => () => ({
    dreaming: {
      enabled: false,
      promotedToday: 0,
      phases: { light: phase(false, false), deep: phase(false, false), rem: phase(false, false) },
      ...dreaming,
    },
  });

  it("binds the switch to configuration and locks turning the host sweep on", async () => {
    const page = await createPage({
      [STATUS]: ownerStatus({ reportedByProvider: true, reportedEnabled: true }),
    });
    page.context.setConfig(OWNER_CONFIG);
    const toggle = getByRole<HTMLInputElement>(page.container, "switch", { name: "Dreaming" });
    await waitForSolid(() => expect(page.state.view().header.owner.locksToggle).toBe(true));
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(page.dreaming.active).toBe(true);
    expect(page.container.textContent).toContain("acme-memory runs its own dreaming.");
    page.state.setEnabled(true);
    flush();
    expect(page.toggle.open).toBe(false);
    expect(page.context.runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("offers turning a running host sweep off with owner-aware confirmation copy", async () => {
    const page = await createPage({
      [STATUS]: ownerStatus({ enabled: true, reportedByProvider: true }),
    });
    page.context.setConfig(OWNER_CONFIG);
    const toggle = getByRole<HTMLInputElement>(page.container, "switch", { name: "Dreaming" });
    await waitForSolid(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(true);
    expect(page.container.textContent).toContain("memory-core's sweep is on as well");
    page.state.setEnabled(false);
    flush();
    expect(page.toggle).toMatchObject({
      open: true,
      enabling: false,
      ownerPluginId: "acme-memory",
    });
    await waitForSolid(() =>
      expect(page.text(".oc-dialog .callout")).toContain(
        "acme-memory keeps running its own dreaming",
      ),
    );
  });

  it("closes the confirmation without writing when the owner's report arrives meanwhile", async () => {
    let reported = false;
    const page = await createPage({
      [STATUS]: () => ownerStatus(reported ? { reportedByProvider: true } : {})(),
    });
    page.context.setConfig(OWNER_CONFIG);
    page.state.setEnabled(true);
    flush();
    expect(page.toggle.open).toBe(true);
    reported = true;
    await page.state.loadResources();
    await waitForSolid(() => expect(page.state.view().header.owner.locksToggle).toBe(true));
    expect(page.toggle.onConfirm()).toBeUndefined();
    flush();
    expect(page.toggle.open).toBe(false);
    expect(page.context.runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("clears the saving state when the owner's report vetoes a queued write", async () => {
    const report: Record<string, unknown> = {};
    const page = await createPage({ [STATUS]: () => ownerStatus(report)() });
    page.context.setConfig(OWNER_CONFIG);
    vi.mocked(page.context.runtimeConfig.patch).mockImplementationOnce(async ({ canDispatch }) => {
      report.reportedByProvider = true;
      await page.state.loadResources("dreamingStatus", false);
      return canDispatch?.() ?? true;
    });
    page.state.setEnabled(true);
    flush();
    await page.toggle.onConfirm();
    expect(page.context.runtimeConfig.patch).toHaveBeenCalledTimes(1);
    expect(page.dreaming).toMatchObject({ modeSaving: false, statusError: null });
    expect(page.toggle.open).toBe(false);
  });

  it.each([
    [
      "a phases-only report with a running phase",
      {
        reportedByProvider: true,
        phases: { light: phase(true, true), deep: phase(false, false), rem: phase(false, false) },
      },
      true,
    ],
    [
      "a counters-only report",
      { reportedByProvider: true, reportedStats: { promotedToday: 3 } },
      false,
    ],
    [
      "an owner reporting off beside a still scheduled host phase",
      {
        reportedEnabled: false,
        phases: { light: phase(true, true), deep: phase(false, false), rem: phase(false, false) },
      },
      true,
    ],
    [
      "a report whose phases are all disabled",
      { reportedByProvider: true, reportedEnabled: false },
      false,
    ],
  ] as const)(
    "lights the scene for %s only when something runs",
    async (_case, dreaming, active) => {
      const page = await createPage({ [STATUS]: ownerStatus(dreaming) });
      page.context.setConfig(OWNER_CONFIG);
      await waitForSolid(() => expect(page.state.view().header.owner.pluginId).toBe("acme-memory"));
      expect(page.dreaming.active).toBe(active);
    },
  );

  it("shows the owner's promoted count in the status while the review keeps memory-core's", async () => {
    const page = await createPage({
      [STATUS]: ownerStatus({
        enabled: true,
        reportedByProvider: true,
        reportedEnabled: true,
        reportedStats: { promotedToday: 4 },
        promotedToday: 2,
        shortTermCount: 5,
      }),
    });
    page.context.setConfig(OWNER_CONFIG);
    await waitForSolid(() => expect(page.dreaming.readStatusData().promotedCount).toBe(4));
    expect(page.dreaming.readStatusData().shortTermCount).toBe(5);
    await waitForSolid(() =>
      expect(page.text(".dreams-controls__status")).toContain("4 promoted today"),
    );
    expect(page.container.textContent).toContain(
      "These lists, counts and actions belong to memory-core's short-term store.",
    );
  });

  it("keeps the switch and copy unchanged when no slot owner reports", async () => {
    const page = await createPage({ [STATUS]: ownerStatus({}) });
    page.context.setConfig(OWNER_CONFIG);
    const toggle = getByRole<HTMLInputElement>(page.container, "switch", { name: "Dreaming" });
    await waitForSolid(() => expect(toggle.disabled).toBe(false));
    expect(page.state.view().header.owner.hint).toBeUndefined();
    expect(page.state.view().header.owner.pluginId).toBeUndefined();
    page.state.setEnabled(true);
    flush();
    expect(page.toggle).toMatchObject({ open: true, ownerPluginId: undefined });
  });
});
