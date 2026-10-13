/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
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
      mountUpdates(createProps({ updateBusy: true, update }));
      expect(row("Status").textContent).toContain("Updating · Staging");
      if (scenario === "read error") {
        expect(row("Status").textContent).toContain("update.runs.get timed out");
      } else if (scenario === "separate campaign") {
        expect(row("Status").textContent).not.toContain("Waiting for active work");
        expect(row("Status").querySelector("[role='timer']")).toBeNull();
        expect(row("Status").textContent).not.toContain("aaaaaaaa");
        expect(row("Current step").textContent).toContain("build");
        expect(row("Update target").querySelector("code")?.title).toBe("b".repeat(40));
        expect(row("Last progress").querySelector("time")?.dateTime).toBe(
          "1970-01-01T00:00:00.900Z",
        );
        const queued = row("Automatic update");
        expect(queued.textContent).toContain("Waiting for active work · forced update in 12:41");
        expect(queued.textContent).toContain("aaaaaaaa");
        expect(queued.querySelector("[role='timer']")?.getAttribute("aria-live")).toBe("off");
      } else {
        expect(row("Update target").textContent).toContain("2026.9.2");
        expect(container.textContent).not.toContain("Automatic updateWaiting");
        expect(() => row("Automatic update")).toThrow("Missing settings row");
        expect(() => row("Current step")).toThrow("Missing settings row");
      }
    },
  );
});
