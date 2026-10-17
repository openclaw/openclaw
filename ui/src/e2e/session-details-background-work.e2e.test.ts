import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { SessionProcessSummary } from "../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session Details background work" });
const now = 1_800_000_000_000;
const parentKey = "agent:main:details-background";

// The mock Gateway's fixture rows always carry a numeric updatedAt.
type SessionFixture = GatewaySessionRow & { updatedAt: number };

function child(
  slug: string,
  label: string,
  state: Partial<GatewaySessionRow>,
  offsetMs: number,
): SessionFixture {
  const key = `agent:main:subagent:${slug}`;
  return {
    key,
    sessionId: slug,
    kind: "direct",
    classification: "subagent",
    label,
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
    createdAt: now - offsetMs,
    startedAt: now - offsetMs,
    ...state,
    updatedAt: now - 1_000,
  };
}

function running(runId: string, headline: string) {
  return {
    status: "running" as const,
    hasActiveRun: true,
    activeRunIds: [runId],
    observerDigest: {
      runId,
      revision: 1,
      updatedAt: now - 2_000,
      headline,
      health: "on-track" as const,
    },
  };
}

function ended(status: GatewaySessionRow["status"], durationMs: number, offsetMs: number) {
  return {
    status,
    hasActiveRun: false,
    activeRunIds: [],
    runtimeMs: durationMs,
    endedAt: now - offsetMs + durationMs,
  };
}

const children: SessionFixture[] = [
  child("ui-review", "UI review", running("run-ui", "Comparing light and dark Details"), 252_000),
  child("api-audit", "Gateway API audit", running("run-api", "Reading the process owner"), 95_000),
  child("docs-check", "Docs check", ended("done", 61_000, 600_000), 600_000),
  child("lint-pass", "Lint pass", ended("done", 38_000, 540_000), 540_000),
  child("bench", "Cold-load benchmark", ended("failed", 132_000, 480_000), 480_000),
  child("i18n", "Locale baseline", ended("done", 12_000, 700_000), 700_000),
];

const processes: SessionProcessSummary[] = [
  {
    processId: "dev-server",
    instanceId: "dev-server-1",
    name: "pnpm ui:dev --port 5173",
    status: "running",
    startedAt: now - 1_380_000,
    tail: "ready in 412 ms",
    truncated: false,
    canStop: true,
  },
  {
    processId: "watch-tests",
    instanceId: "watch-tests-1",
    name: "node scripts/run-vitest.mjs run ui/src/pages/chat",
    status: "running",
    startedAt: now - 74_000,
    tail: "",
    truncated: false,
    canStop: true,
  },
  {
    processId: "build",
    instanceId: "build-1",
    name: "pnpm ui:build",
    status: "completed",
    startedAt: now - 900_000,
    endedAt: now - 846_000,
    exitCode: 0,
    tail: "built in 53.2s",
    truncated: false,
    canStop: false,
  },
  {
    processId: "typecheck",
    instanceId: "typecheck-1",
    name: "pnpm tsgo:ui",
    status: "failed",
    startedAt: now - 820_000,
    endedAt: now - 790_000,
    exitCode: 2,
    tail: "error TS2322",
    truncated: false,
    canStop: false,
  },
];

suite.define(() => {
  it("visualizes subagents and background processes in Details", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      await suite.withPage(
        { colorScheme, locale: "en-US", viewport: { width: 1728, height: 1100 } },
        async ({ page }) => {
          await page.clock.setFixedTime(now);
          await page.addInitScript(
            ([key, themeMode]) => localStorage.setItem(key, JSON.stringify({ themeMode })),
            [controlUiBundledSettingsStorageKey(suite.server.baseUrl), colorScheme] as const,
          );
          const parent: SessionFixture = {
            key: parentKey,
            sessionId: "details-background",
            kind: "direct",
            sharingRole: "owner",
            label: "Visualize background work",
            status: "running",
            hasActiveRun: true,
            hasActiveSubagentRun: true,
            activeRunIds: ["parent-run"],
            startedAt: now - 300_000,
            updatedAt: now - 1_000,
            childSessions: children.map((row) => row.key),
          };
          const gateway = await installMockGateway(page, {
            sessionKey: parentKey,
            sessions: [parent, ...children],
            historyMessages: [
              {
                role: "assistant",
                content: "Delegating the review and starting the dev server.",
                timestamp: now - 290_000,
                __openclaw: { id: "delegating", seq: 1 },
              },
            ],
            featureMethods: [...defaultControlUiFeatureMethods, "sessions.processes.list"],
            methodResponses: {
              "cron.list": cronListResponseFixture({
                jobs: [],
                snapshotRevision: "details-background",
                total: 0,
                offset: 0,
                limit: 50,
                hasMore: false,
                nextOffset: null,
              }),
              "sessions.processes.list": {
                sessionId: "details-background",
                processes,
                truncated: false,
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
          const pane = page.locator(".chat-pane-cache__pane--active");
          const details = await openChatDetails(pane);
          const subagents = details.locator('[data-details-group="subagents"]');
          const processGroup = details.locator('[data-details-group="processes"]');
          await expect
            .poll(() =>
              details
                .locator("[data-details-group] > summary .chat-details__tally-summary")
                .allTextContents(),
            )
            .toEqual(["2 running · 3 done · 1 failed", "2 running · 1 done · 1 failed"]);
          // Live work leads, failures follow, and the rest waits behind Show more.
          expect(
            await subagents.locator(".chat-subagent-activity__status").allTextContents(),
          ).toEqual(["Comparing light and dark Details", "Reading the process owner", "Failed"]);
          expect(
            await processGroup
              .locator("[data-process-id]")
              .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-process-id"))),
          ).toEqual(["dev-server", "watch-tests", "typecheck"]);
          // Session rows omit plan steps; the live observer stream reports them.
          await gateway.emitGatewayEvent("session.observer", {
            sessionKey: "agent:main:subagent:ui-review",
            sessionId: "ui-review",
            runId: "run-ui",
            revision: 2,
            updatedAt: now,
            health: "on-track",
            headline: "Comparing light and dark Details",
            planProgress: { completed: 2, total: 4 },
          });
          await expect
            .poll(() => subagents.locator(".chat-subagent-activity__steps").textContent())
            .toBe("2/4");

          const frame = await takeControlUiScreenshotFrame(page, details, [details], {
            animations: "disabled",
            elements: [details],
          });
          await writeFile(
            path.join(suite.artifactDir, `details-background-${colorScheme}.png`),
            frame.elements[0]!.png,
          );
          await subagents.getByRole("button", { name: "Show 3 more" }).click();
          await expect.poll(() => subagents.locator("[data-subagent-session-key]").count()).toBe(6);
          // A collapsed group keeps its counts and bar in the heading.
          await processGroup.locator("summary").click();
          await expect
            .poll(() => processGroup.evaluate((group) => (group as HTMLDetailsElement).open))
            .toBe(false);
          expect(await processGroup.locator("summary .chat-details__tally").isVisible()).toBe(true);
          const expanded = await takeControlUiScreenshotFrame(page, details, [details], {
            animations: "disabled",
            elements: [details],
          });
          await writeFile(
            path.join(suite.artifactDir, `details-background-${colorScheme}-expanded.png`),
            expanded.elements[0]!.png,
          );
          await processGroup.locator("summary").click();
          await processGroup.getByRole("button", { name: "All processes" }).click();
          await page.locator("openclaw-chat-processes-panel").first().waitFor();
          expect(gateway).toBeDefined();
        },
      );
    }
  });
});
