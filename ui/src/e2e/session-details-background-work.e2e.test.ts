import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
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
    name: "Background terminal",
    status: "running",
    startedAt: now - 1_380_000,
    tail: "ready in 412 ms",
    truncated: false,
    canStop: true,
  },
  {
    processId: "watch-tests",
    instanceId: "watch-tests-1",
    name: "/workspace/openclaw/projects/desktop-details/background-process-verification",
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
            deferredMethods: ["sessions.processes.list"],
            sessions: [parent, ...children],
            historyMessages: [
              {
                role: "assistant",
                content: "Delegating the review and starting the dev server.",
                timestamp: now - 290_000,
                __openclaw: { id: "delegating", seq: 1 },
              },
            ],
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "sessions.processes.list",
              "sessions.processes.stop",
            ],
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
          const capture = async (name: string, details: Locator, content: Locator[]) => {
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
              return;
            }
            const frame = await takeControlUiScreenshotFrame(page, details, content, {
              animations: "disabled",
              elements: [details],
            });
            await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
            await writeFile(
              path.join(suite.artifactDir, `${name}-details.png`),
              frame.elements[0]!.png,
            );
          };
          for (const width of [1728, 1100, 390]) {
            await page.setViewportSize({ width, height: 1100 });
            await pane
              .locator(width === 390 ? ".agent-chat__header--mobile" : ".chat-details-toggle")
              .waitFor();
            if (width !== 390) {
              await expect
                .poll(() => pane.locator(".chat-details").getAttribute("role"))
                .toBe(width === 1728 ? "complementary" : "dialog");
            }
            const details = await openChatDetails(pane);
            if (width === 1728) {
              const loading = details.locator('[data-details-group="processes"]');
              await gateway.waitForRequest("sessions.processes.list");
              expect(await loading.count()).toBe(0);
              await capture(`processes-loading-${colorScheme}`, details, [details]);
              await gateway.resolveDeferred("sessions.processes.list", {
                sessionId: "details-background",
                processes,
                truncated: false,
              });
            }
            if (width === 390) {
              await details
                .locator(".chat-mobile-host__header")
                .getByRole("button", {
                  name: "Expand Side panel",
                  exact: true,
                })
                .click();
              await pane.locator('.chat-mobile-host[data-mode="expanded"]').waitFor();
            }
            const subagents = details.locator('[data-details-group="subagents"]');
            const summary = subagents.getByRole("button", {
              name: "All subagents. 2 Working, 4 Done",
              exact: true,
            });
            await summary.waitFor();
            expect(await subagents.locator("[data-subagent-session-key]").count()).toBe(0);
            if (width !== 390) {
              const heading = subagents.locator(":scope > summary");
              await heading.click();
              await subagents
                .getByRole("img", { name: "2 subagents running", exact: true })
                .waitFor();
              expect(await summary.isVisible()).toBe(false);
              await heading.click();
              await summary.waitFor();
            }
            // The whole summary remains a hit target, including its leading inset.
            await summary.hover({ position: { x: 2, y: 10 } });
            expect(
              await summary.evaluate((row) => {
                const bounds = row.getBoundingClientRect();
                return row.contains(document.elementFromPoint(bounds.left + 2, bounds.top + 10));
              }),
            ).toBe(true);
            const processGroup = details.locator('[data-details-group="processes"]');
            if (width === 390) {
              await processGroup.locator("[data-process-id]").first().waitFor();
              expect(
                await processGroup
                  .locator("[data-process-id]")
                  .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-process-id"))),
              ).toEqual(["dev-server", "watch-tests"]);
              await processGroup.getByRole("button", { name: "Show all", exact: true }).waitFor();
            } else {
              await processGroup.locator("[data-process-id]").first().waitFor();
              expect(await processGroup.locator("[data-process-id]").count()).toBe(4);
              expect(
                await processGroup.evaluate((element) =>
                  element.previousElementSibling?.getAttribute("data-details-group"),
                ),
              ).toBe("subagents");
              const first = processGroup.locator('[data-process-id="dev-server"]');
              const stop = first.getByRole("button", {
                name: "Stop Background terminal",
                exact: true,
              });
              await page.mouse.move(0, 0);
              await expect
                .poll(() => stop.evaluate((element) => getComputedStyle(element).opacity))
                .toBe("0");
              await first.hover();
              await expect
                .poll(() => stop.evaluate((element) => getComputedStyle(element).opacity))
                .toBe("1");
              const badge = first.locator(".chat-details-processes__badge");
              expect(await badge.isVisible()).toBe(true);
              const bounds = await first.locator(".chat-details-processes__icon").boundingBox();
              const statusBounds = await badge.boundingBox();
              expect(statusBounds!.x).toBeGreaterThan(bounds!.x + bounds!.width / 2);
              expect(statusBounds!.y).toBeGreaterThan(bounds!.y + bounds!.height / 2);
              await capture(`processes-hover-${colorScheme}-${width}`, details, [first]);
              await page.mouse.move(0, 0);
              await first.locator(".chat-details-processes__open").focus();
              await page.keyboard.press("Tab");
              expect(await stop.evaluate((element) => element === document.activeElement)).toBe(
                true,
              );
              expect(await stop.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
              await capture(`processes-focus-${colorScheme}-${width}`, details, [first]);
              const longName = processGroup.locator(
                '[data-process-id="watch-tests"] .chat-details-processes__name',
              );
              expect(
                await longName.evaluate((element) => element.scrollWidth > element.clientWidth),
              ).toBe(true);
              expect(await longName.textContent()).toBe(processes[1]!.name);
              await expect
                .poll(() => longName.evaluate((element) => getComputedStyle(element).maskImage))
                .not.toBe("none");
              const restBounds = (await longName.boundingBox())!;
              const rowBounds = (await longName.locator("..").boundingBox())!;
              expect(restBounds.x + restBounds.width).toBe(rowBounds.x + rowBounds.width - 4);
              const restFade = await longName.evaluate(
                (element) => getComputedStyle(element).maskImage,
              );
              await longName.hover();
              expect(await longName.boundingBox()).toEqual(restBounds);
              expect(
                await longName.evaluate((element) => getComputedStyle(element).maskImage),
              ).not.toBe(restFade);
              expect(await longName.locator("..").getAttribute("aria-label")).toContain(
                processes[1]!.name,
              );
              expect(
                await processGroup
                  .locator('[data-status="completed"] .chat-details-processes__stop')
                  .count(),
              ).toBe(0);
              expect(
                await processGroup
                  .locator('[data-status="failed"] .chat-details-processes__stop')
                  .count(),
              ).toBe(0);
              if (width === 1728) {
                await gateway.deferNext("sessions.processes.stop");
                await stop.press("Enter");
                const request = await gateway.waitForRequest("sessions.processes.stop");
                expect(request.params).toMatchObject({
                  key: parentKey,
                  sessionId: "details-background",
                  processId: "dev-server",
                  instanceId: "dev-server-1",
                });
                await expect.poll(() => stop.isDisabled()).toBe(true);
                expect(await first.getByRole("status").textContent()).toBe("Stopping…");
                expect(await badge.isVisible()).toBe(true);
                expect(await pane.locator("openclaw-chat-processes-panel").count()).toBe(0);
                await capture(`processes-stopping-${colorScheme}`, details, [first]);
                await gateway.resolveDeferred("sessions.processes.stop", { requested: false });
                await processGroup.getByRole("alert").waitFor();
                await capture(`processes-error-${colorScheme}`, details, [
                  processGroup.getByRole("alert"),
                ]);
                await processGroup.getByRole("button", { name: "Retry", exact: true }).click();
                await processGroup.getByRole("alert").waitFor({ state: "detached" });
                const unavailable = processes.map((row) =>
                  row.processId === "watch-tests" ? { ...row, canStop: false } : row,
                );
                await gateway.setMethodResponse("sessions.processes.list", {
                  sessionId: "details-background",
                  processes: unavailable,
                  truncated: false,
                });
                await gateway.emitGatewayEvent("sessions.processes.changed", {
                  sessionKey: parentKey,
                  agentId: "main",
                });
                await expect
                  .poll(() =>
                    processGroup
                      .locator('[data-process-id="watch-tests"] .chat-details-processes__stop')
                      .count(),
                  )
                  .toBe(0);
                await capture(`processes-unavailable-${colorScheme}`, details, [processGroup]);
                const stopped = processes.map((row) =>
                  row.processId === "dev-server"
                    ? { ...row, status: "killed", canStop: false, endedAt: now }
                    : row,
                );
                await gateway.deferNext("sessions.processes.stop");
                await stop.click();
                await expect
                  .poll(async () => (await gateway.getRequests("sessions.processes.stop")).length)
                  .toBe(2);
                await gateway.setMethodResponse("sessions.processes.list", {
                  sessionId: "details-background",
                  processes: stopped,
                  truncated: false,
                });
                await gateway.resolveDeferred("sessions.processes.stop", { requested: true });
                await expect.poll(() => first.getAttribute("data-status")).toBe("killed");
                expect(await first.locator(".chat-details-processes__stop").count()).toBe(0);
                await page.mouse.move(0, 0);
                await subagents.locator(":scope > summary").scrollIntoViewIfNeeded();
                await capture(`processes-stopped-${colorScheme}`, details, [first]);
                await gateway.setMethodResponse("sessions.processes.list", {
                  sessionId: "details-background",
                  processes: processes.map((row) =>
                    row.status === "running"
                      ? { ...row, status: "killed", canStop: false, endedAt: now }
                      : row,
                  ),
                  truncated: false,
                });
                await gateway.emitGatewayEvent("sessions.processes.changed", {
                  sessionKey: parentKey,
                  agentId: "main",
                });
                await processGroup.waitFor({ state: "detached" });
                await capture(`processes-terminal-${colorScheme}`, details, [subagents]);
                await gateway.setMethodResponse("sessions.processes.list", {
                  sessionId: "details-background",
                  processes,
                  truncated: false,
                });
                await gateway.emitGatewayEvent("sessions.processes.changed", {
                  sessionKey: parentKey,
                  agentId: "main",
                });
                await expect.poll(() => processGroup.locator("[data-process-id]").count()).toBe(4);
                await gateway.setMethodResponse("sessions.processes.list", {
                  sessionId: "details-background",
                  processes: [],
                  truncated: false,
                });
                await gateway.emitGatewayEvent("sessions.processes.changed", {
                  sessionKey: parentKey,
                  agentId: "main",
                });
                await processGroup.waitFor({ state: "detached" });
                await capture(`processes-empty-${colorScheme}`, details, [subagents]);
                await gateway.deferNext("sessions.processes.list");
                await gateway.emitGatewayEvent("sessions.processes.changed", {
                  sessionKey: parentKey,
                  agentId: "main",
                });
                await gateway.rejectDeferred("sessions.processes.list", {
                  code: "UNAVAILABLE",
                  message: "Process list temporarily unavailable",
                });
                const listError = details.getByRole("alert").filter({
                  hasText: "Process list temporarily unavailable",
                });
                await listError.waitFor();
                expect(await processGroup.count()).toBe(0);
                await capture(`processes-list-error-${colorScheme}`, details, [listError]);
                await listError.getByRole("button", { name: "Retry", exact: true }).click();
                await listError.waitFor({ state: "detached" });
                expect(await processGroup.count()).toBe(0);
                await gateway.setMethodResponse("sessions.processes.list", {
                  sessionId: "details-background",
                  processes,
                  truncated: false,
                });
                await gateway.emitGatewayEvent("sessions.processes.changed", {
                  sessionKey: parentKey,
                  agentId: "main",
                });
                await expect.poll(() => processGroup.locator("[data-process-id]").count()).toBe(4);
              }
              await first
                .locator(".chat-details-processes__open")
                .evaluate((element) => (element as HTMLElement).blur());
              await page.mouse.move(0, 0);
            }
            const frame = await takeControlUiScreenshotFrame(page, details, [summary], {
              animations: "disabled",
              elements: [details, subagents, processGroup],
            });
            await writeFile(
              path.join(suite.artifactDir, `details-background-${colorScheme}-${width}.png`),
              frame.png,
            );
            await writeFile(
              path.join(
                suite.artifactDir,
                `details-background-${colorScheme}-${width}-details.png`,
              ),
              frame.elements[0]!.png,
            );
            if (width === 1728) {
              await processGroup
                .locator('[data-process-id="dev-server"] .chat-details-processes__open')
                .click();
              const panel = pane.locator("openclaw-chat-processes-panel");
              await panel.getByRole("button", { name: processes[0]!.name, exact: true }).waitFor();
              await pane.getByRole("button", { name: "Close Processes", exact: true }).click();
              await panel.waitFor({ state: "hidden" });
            }
            if (width === 390) {
              await processGroup.getByRole("button", { name: "Show all", exact: true }).click();
              const panel = pane.locator("openclaw-chat-processes-panel");
              await panel.getByRole("button", { name: processes[0]!.name, exact: true }).waitFor();
              await panel.getByRole("button", { name: /Finished/ }).click();
              await expect.poll(() => panel.locator("[data-process-id]").count()).toBe(4);
              await pane
                .locator(".chat-mobile-host__header")
                .getByRole("button", {
                  name: "Close",
                  exact: true,
                })
                .click();
              await openChatDetails(pane);
              await summary.click();
              const collection = pane.locator("openclaw-chat-subagents-panel");
              await collection
                .locator(
                  '[data-session-key="agent:main:subagent:ui-review"] .chat-subagents-mobile__open',
                )
                .waitFor();
              expect(
                await collection
                  .locator(".chat-subagents-mobile__disclosure")
                  .getAttribute("aria-expanded"),
              ).toBe("true");
              await expect.poll(() => collection.locator("[data-session-key]").count()).toBe(6);
            }
          }
          await page.setViewportSize({ width: 1728, height: 1100 });
          await pane.locator(".chat-details-toggle").waitFor();
          const details = await openChatDetails(pane);
          await details.getByRole("button", { name: /All subagents\. 2 Working/ }).click();
          const collection = pane.locator("openclaw-chat-subagents-panel");
          const runningRow = collection.locator(
            '[data-session-key="agent:main:subagent:ui-review"]',
          );
          await runningRow.waitFor();
          await expect
            .poll(() => runningRow.textContent())
            .toContain("Comparing light and dark Details");
          expect(
            await collection
              .locator(".subagents-desktop__disclosure")
              .getAttribute("aria-expanded"),
          ).toBe("true");
          await expect.poll(() => collection.locator("[data-session-key]").count()).toBe(6);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    }
  });
});
