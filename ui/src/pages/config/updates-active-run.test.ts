/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import {
  createUpdatesViewDom,
  createUpdatesViewProps as createProps,
} from "./updates.test-support.ts";
import { renderUpdates } from "./updates.ts";

let container: HTMLDivElement;
let row: ReturnType<typeof createUpdatesViewDom>["row"];

beforeEach(async () => {
  await i18n.setLocale("en");
  ({ container, row } = createUpdatesViewDom());
});

describe("running update status", () => {
  it("keeps a progress read error visible alongside the last-known running phase", () => {
    render(
      renderUpdates(
        createProps({
          updateBusy: true,
          update: {
            updateRun: createUpdateRunFixture(),
            updateStatusBanner: {
              source: "read",
              tone: "danger",
              text: "update.runs.get timed out",
            },
          },
        }),
      ),
      container,
    );
    expect(row("Status").textContent).toContain("Updating · Staging");
    expect(row("Status").textContent).toContain("update.runs.get timed out");
  });

  it("shows the executing run separately from a waiting automatic campaign", () => {
    render(
      renderUpdates(
        createProps({
          updateBusy: true,
          update: {
            updateRun: createUpdateRunFixture({
              target: { kind: "git", sha: "b".repeat(40) },
              steps: [{ step: "build", status: "in_progress" }],
              updatedAtMs: 900,
            }),
            updateStatusRefreshing: true,
            updateStatusCheckBanner: {
              mode: "manual",
              tone: "warn",
              text: "Could not fetch upstream",
            },
            updateSchedule: {
              channel: "dev",
              autoEnabled: true,
              install: { kind: "git" },
              target: {
                kind: "git",
                upstreamRef: "origin/main",
                upstreamSha: "a".repeat(40),
                commitsBehind: 3,
              },
              campaign: {
                id: "separate-campaign",
                state: "waiting-for-idle",
                announcedAtMs: 1_000,
                forceAtMs: 762_000,
                updatedAtMs: 1_000,
              },
            },
          },
        }),
      ),
      container,
    );

    expect(row("Status").textContent).toContain("Updating · Staging");
    expect(row("Status").textContent).not.toContain("Waiting for active work");
    expect(row("Status").querySelector("[role='timer']")).toBeNull();
    expect(row("Status").textContent).not.toContain("aaaaaaaa");
    expect(row("Current step").textContent).toContain("build");
    expect(row("Update target").querySelector("code")?.title).toBe("b".repeat(40));
    expect(row("Last progress").querySelector("time")?.dateTime).toBe("1970-01-01T00:00:00.900Z");
    const queued = row("Automatic update");
    expect(queued.textContent).toContain("Waiting for active work · forced update in 12:41");
    expect(queued.textContent).toContain("aaaaaaaa");
    expect(queued.querySelector("[role='timer']")?.getAttribute("aria-live")).toBe("off");
  });

  it("does not duplicate the campaign owned by the executing run", () => {
    render(
      renderUpdates(
        createProps({
          updateBusy: true,
          update: {
            updateRun: createUpdateRunFixture({ origin: { campaignId: "same-campaign" } }),
            updateSchedule: {
              channel: "stable",
              autoEnabled: true,
              campaign: {
                id: "same-campaign",
                state: "applying",
                announcedAtMs: 1_000,
                forceAtMs: 762_000,
                updatedAtMs: 1_000,
              },
            },
          },
        }),
      ),
      container,
    );
    expect(row("Status").textContent).toContain("Updating · Staging");
    expect(row("Update target").textContent).toContain("2026.9.2");
    expect(container.textContent).not.toContain("Automatic updateWaiting");
    expect(() => row("Automatic update")).toThrow("Missing settings row");
    expect(() => row("Current step")).toThrow("Missing settings row");
  });
});
