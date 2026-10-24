/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import {
  createUpdatesViewDom,
  createUpdatesViewProps as createProps,
} from "./updates.test-support.ts";

let container: ReturnType<typeof createUpdatesViewDom>["container"];
let mountUpdates: ReturnType<typeof createUpdatesViewDom>["mountUpdates"];
let row: ReturnType<typeof createUpdatesViewDom>["row"];

beforeEach(async () => {
  await i18n.setLocale("en");
  ({ container, row, mountUpdates } = createUpdatesViewDom());
});

describe("running update status", () => {
  it.each(["read error", "separate campaign", "same campaign"] as const)(
    "keeps executing run status distinct from %s",
    (scenario) => {
      const update: NonNullable<Parameters<typeof createProps>[0]>["update"] = {
        updateRun: createUpdateRunFixture(),
      };
      if (scenario === "read error") {
        update.updateStatusBanner = {
          source: "read",
          tone: "danger",
          text: "update.runs.get timed out",
        };
      } else {
        const separate = scenario === "separate campaign";
        update.updateSchedule = {
          channel: separate ? "dev" : "stable",
          autoEnabled: true,
          campaign: {
            id: scenario,
            state: separate ? "waiting-for-idle" : "applying",
            announcedAtMs: 1_000,
            forceAtMs: 762_000,
            updatedAtMs: 1_000,
          },
        };
        if (separate) {
          update.updateRun = createUpdateRunFixture({
            target: { kind: "git", sha: "b".repeat(40) },
            steps: [{ step: "build", status: "in_progress" }],
            updatedAtMs: 900,
          });
          update.updateStatusRefreshing = true;
          update.updateStatusCheckBanner = {
            mode: "manual",
            tone: "warn",
            text: "Could not fetch upstream",
          };
          update.updateSchedule.install = { kind: "git" };
          update.updateSchedule.target = {
            kind: "git",
            upstreamRef: "origin/main",
            upstreamSha: "a".repeat(40),
            commitsBehind: 3,
          };
        } else {
          update.updateRun = createUpdateRunFixture({ origin: { campaignId: scenario } });
        }
      }
      const onUpdateNow = vi.fn(async () => undefined);
      mountUpdates(
        createProps({
          updateBusy: true,
          update,
          onUpdateNow,
          statusRead: new Promise<boolean>(() => {}),
        }),
      );
      expect(row("Status").textContent).toContain("Updating · Staging");
      if (scenario === "read error") {
        expect(row("Status").textContent).toContain("update.runs.get timed out");
      } else if (scenario === "separate campaign") {
        expect(row("Status").textContent).not.toContain("Waiting for active work");
        expect(row("Status").querySelector("[role='timer']")).toBeNull();
        expect(row("Status").textContent).not.toContain("aaaaaaaa");
      }
      const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "View result",
      )!;
      result.click();
      expect(onUpdateNow).toHaveBeenCalledWith(update.updateRun);
      expect(container.querySelector("openclaw-update-run-view")).toBeNull();
    },
  );
});
