/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import { mountConfigPage } from "./config-page.test-support.ts";

it.each([
  ["owner administrator", "gateway-owner", "operator.admin", true, true],
  ["named administrator", "other-operator", "operator.admin", true, true],
  ["unidentified administrator", null, "operator.admin", true, false],
  ["owner without administrator scope", "gateway-owner", "operator.write", true, false],
  ["disconnected owner", "gateway-owner", "operator.admin", false, false],
] as const)(
  "gates report clicks for %s with a stale method catalog",
  async (_label, profileId, scope, connected, allowed) => {
    const reportUpdateFailure = vi.fn(async () => undefined);
    const run = createUpdateRunFixture({
      phase: "finished",
      status: "failed",
      reason: "build-failed",
      finishedAtMs: 500,
    });
    const context = {
      config: {
        current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "2026.8.1" },
      },
      runtimeConfig: {
        canSet: true,
        state: {
          connected: true,
          configForm: { update: { channel: "stable", auto: { enabled: false } } },
          configSnapshot: null,
        },
        patchForm: vi.fn(),
      },
      gateway: {
        snapshot: {
          client: {},
          phase: connected ? "connected" : "reconnecting",
          selfUser: profileId ? { id: profileId } : null,
          hello: {
            auth: { role: "operator", scopes: [scope] },
            features: { methods: ["update.status"] },
          },
        },
        subscribe: () => () => undefined,
      },
      overlays: {
        snapshot: {
          updateAvailable: null,
          updateSchedule: null,
          updateRunning: false,
          updateReconciliationPending: false,
          updateStatusBanner: { tone: "danger", text: "Update failed" },
          updateRun: run,
          reportableUpdateFailureId: run.runId,
          updateFailureReportBusy: false,
          updateFailureReportNotice: null,
          heldUpdateCampaignId: null,
        },
        subscribe: () => () => undefined,
        reportUpdateFailure,
        refreshUpdateStatus: vi.fn(async () => true),
        runUpdate: vi.fn(),
      },
    } as unknown as ApplicationContext;
    const { container } = mountConfigPage(context, { pageId: "updates" });
    const report = await waitForSolid(() => {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Report update failure",
      );
      expect(button).toBeDefined();
      return button!;
    });
    expect(report).toMatchObject({ disabled: !allowed });
    report.click();
    expect(reportUpdateFailure.mock.calls).toEqual(allowed ? [[run.runId]] : []);
  },
);
