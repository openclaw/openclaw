import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectNoRequests, expectRequestCount } from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagents panel nesting" });
const previewModel = {
  agentModel: "openai/gpt-4.1",
  models: [{ id: "gpt-4.1", name: "Preview model", provider: "openai" }],
};

function scenario() {
  const now = Date.now();
  const parent = {
    key: "agent:main:panel-parent",
    agentId: "main",
    sessionId: "parent-session",
    kind: "direct",
    label: "Workspace review",
    updatedAt: now,
    hasActiveSubagentRun: true,
  } satisfies GatewaySessionRow;
  const child = {
    key: "agent:main:subagent:notice-review",
    agentId: "main",
    sessionId: "notice-session",
    kind: "direct",
    classification: "subagent",
    label: "Check notice dismissal",
    spawnedBy: parent.key,
    updatedAt: now,
    hasActiveRun: true,
    status: "running",
    activeRunIds: ["notice-run"],
    startedAt: now - 40_000,
  } satisfies GatewaySessionRow;
  return {
    parent,
    child,
    other: {
      ...child,
      key: "agent:main:subagent:keyboard-review",
      sessionId: "keyboard-session",
      activeRunIds: ["keyboard-run"],
    },
  };
}

suite.define(() => {
  it("aligns the finished family branch and dividers with the root row grid", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark", locale: "en-US" },
      async ({ page }) => {
        const fixture = scenario();
        const finished = {
          ...fixture.child,
          label: "Review workspace changes",
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
          runtimeMs: 73_000,
        } satisfies GatewaySessionRow;
        const nested = {
          ...finished,
          key: "agent:main:subagent:nested-reviewer",
          sessionId: "nested-reviewer-session",
          label: "Check the notice dismissal and keyboard focus",
          parentSessionKey: finished.key,
          spawnedBy: finished.key,
          runtimeMs: 29_000,
        } satisfies GatewaySessionRow;
        const next = {
          ...finished,
          key: fixture.other.key,
          sessionId: fixture.other.sessionId,
          label: "Verify desktop navigation after returning to the workspace",
          updatedAt: finished.updatedAt - 1,
          runtimeMs: 1_065_000,
        } satisfies GatewaySessionRow;
        const parent = { ...fixture.parent, hasActiveSubagentRun: false };
        await installMockGateway(page, {
          ...previewModel,
          sessionKey: parent.key,
          sessions: [parent, { ...finished, childSessions: [nested.key] }, nested, next],
          methodResponses: {
            "config.get": configResponse({ themeMode: "system" }, "nested-review"),
            "users.prefs.get": { status: "ok", entries: { "ui.themeMode": "system" } },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        await openChatSidePanelType(page, "Subagents");
        const surface = page.locator(".chat-pane-cache__pane--active .subagents-desktop");
        const rowByKey = (key: string) => surface.locator(`[data-session-key="${key}"]`);
        const rootRow = rowByKey(finished.key);
        const nestedRow = rowByKey(nested.key);
        const nextRow = rowByKey(next.key);
        const frame = await takeControlUiScreenshotFrame(
          page,
          surface,
          [rootRow, nestedRow, nextRow],
          {
            animations: "disabled",
            elements: [surface],
          },
        );
        await writeFile(
          path.join(suite.artifactDir, "finished-family-panel.png"),
          frame.elements[0]!.png,
        );

        const geometry = await nestedRow.evaluate((item) => {
          const root = item.previousElementSibling!;
          const nextRoot = item.nextElementSibling!;
          const avatar = (row: Element) =>
            row.querySelector(".subagents-desktop__avatar")!.getBoundingClientRect();
          const bounds = item.getBoundingClientRect();
          const branch = getComputedStyle(item, "::before");
          const divider = getComputedStyle(item, "::after");
          const parentStem = getComputedStyle(
            root.querySelector(".subagents-desktop__open")!,
            "::before",
          );
          const center = (rect: DOMRect) => rect.left + rect.width / 2;
          const elapsedEnd = (row: Element) =>
            row.querySelector(".subagents-desktop__elapsed")!.getBoundingClientRect().right;
          return {
            parentCenter: center(avatar(root)),
            stemCenter:
              bounds.left +
              Number.parseFloat(branch.left) +
              Number.parseFloat(branch.borderLeftWidth) / 2,
            parentStemCenter:
              root.getBoundingClientRect().left +
              Number.parseFloat(parentStem.left) +
              Number.parseFloat(parentStem.borderLeftWidth) / 2,
            parentStemEnd:
              root.getBoundingClientRect().bottom - Number.parseFloat(parentStem.bottom),
            childStemStart: bounds.top + Number.parseFloat(branch.top),
            elbowCenter:
              bounds.top +
              Number.parseFloat(branch.top) +
              Number.parseFloat(branch.height) -
              Number.parseFloat(branch.borderBottomWidth) / 2,
            childAvatarCenter: avatar(item).top + avatar(item).height / 2,
            elbowGap:
              avatar(item).left -
              (bounds.left + Number.parseFloat(branch.left) + Number.parseFloat(branch.width)),
            dividerStart: bounds.left + Number.parseFloat(divider.left),
            rootTitleStart: nextRoot
              .querySelector(".subagents-desktop__name")!
              .getBoundingClientRect().left,
            elapsedEnd: [elapsedEnd(root), elapsedEnd(item), elapsedEnd(nextRoot)],
          };
        });
        expect(geometry.stemCenter).toBeCloseTo(geometry.parentCenter);
        expect(geometry.parentStemCenter).toBeCloseTo(geometry.stemCenter);
        expect(geometry.parentStemEnd).toBeCloseTo(geometry.childStemStart);
        expect(geometry.elbowCenter).toBeCloseTo(geometry.childAvatarCenter);
        expect(geometry.elbowGap).toBeGreaterThan(0);
        expect(geometry.elbowGap).toBeLessThanOrEqual(4);
        expect(geometry.dividerStart).toBeCloseTo(geometry.rootTitleStart);
        expect(geometry.elapsedEnd).toEqual(Array(3).fill(geometry.elapsedEnd[0]));
      },
    );
  });

  it("shows nested reviewers under their parent in the Subagents tab with scoped actions and live membership", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, colorScheme: "dark", locale: "en-US" },
      async ({ page }) => {
        const fixture = scenario();
        const parent = { ...fixture.parent, label: "Review workspace changes" };
        const child = {
          ...fixture.child,
          label: "Implement notice repair",
          hasActiveRun: false,
          hasActiveSubagentRun: true,
          activeRunIds: [],
        } satisfies GatewaySessionRow;
        const reviewer = {
          ...fixture.other,
          key: "agent:main:subagent:nested-reviewer",
          sessionId: "nested-reviewer-session",
          label: "Review the notice repair",
          spawnedBy: child.key,
          parentSessionKey: child.key,
          activeRunIds: ["nested-reviewer-run"],
        } satisfies GatewaySessionRow;
        const unrelated = {
          ...reviewer,
          key: "agent:main:subagent:unrelated-reviewer",
          sessionId: "unrelated-reviewer-session",
          label: "Review an unrelated workspace",
          spawnedBy: "agent:main:another-parent",
          parentSessionKey: "agent:main:another-parent",
        } satisfies GatewaySessionRow;
        const gateway = await installMockGateway(page, {
          ...previewModel,
          sessionKey: parent.key,
          sessions: [parent, child, reviewer, unrelated],
          historyMessages: [
            { role: "assistant", content: "The implementation is awaiting its nested review." },
          ],
          sessionTranscripts: {
            [reviewer.key]: {
              messages: [
                {
                  role: "assistant",
                  content: "Checking the repair against the original regression.",
                },
              ],
              inFlightRun: { runId: "nested-reviewer-run", startedAt: reviewer.startedAt },
            },
          },
          methodResponses: {
            "config.get": configResponse({ themeMode: "system" }, "nested-review"),
            "users.prefs.get": { status: "ok", entries: { "ui.themeMode": "system" } },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const parentPane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const draft = parentPane.locator(".agent-chat__composer-combobox textarea");
        await draft.fill("Keep the parent review draft");
        const activePane = page.locator(".chat-pane-cache__pane--active");
        const details = await openChatDetails(activePane);
        await details.getByText(child.label, { exact: true }).waitFor();
        expect(await details.getByText(reviewer.label, { exact: true }).count()).toBe(0);
        await closeChatDetails(activePane);
        await openChatSidePanelType(page, "Subagents");
        const panel = parentPane.locator("openclaw-chat-subagents-panel");
        const surface = panel.locator(".subagents-desktop");
        const childRow = surface.locator(`[data-session-key="${child.key}"]`);
        const reviewerRow = surface.locator(`[data-session-key="${reviewer.key}"]`);
        await childRow.waitFor();

        // Capture the actual tab before asserting the regression so a failing baseline
        // retains all three desktop presentations, not the unrelated floating Details.
        const directory = suite.artifactDir;
        for (const capture of [
          { name: "dark", mode: "dark", width: 1440 },
          { name: "light", mode: "light", width: 1440 },
          { name: "narrow-desktop", mode: "dark", width: 1024 },
        ] as const) {
          await page.emulateMedia({ colorScheme: capture.mode });
          await expect
            .poll(() => page.locator("html").getAttribute("data-theme-mode"))
            .toBe(capture.mode);
          const frame = await takeControlUiScreenshotFrame(page, surface, [childRow], {
            animations: "disabled",
            viewport: { width: capture.width, height: 1000 },
            elements: [surface],
          });
          await writeFile(path.join(directory, `nested-review-${capture.name}.png`), frame.png);
          await writeFile(
            path.join(directory, `nested-review-${capture.name}-panel.png`),
            frame.elements[0]!.png,
          );
        }
        await writeFile(
          path.join(directory, "nested-review-requests.json"),
          JSON.stringify(await gateway.getRequests("sessions.list"), null, 2),
        );
        console.log("Nested reviewer evidence:", directory);

        await expect.poll(() => reviewerRow.count()).toBe(1);
        expect(await childRow.evaluate((row) => getComputedStyle(row, "::after").content)).toBe(
          "none",
        );
        expect(await reviewerRow.evaluate((row) => getComputedStyle(row, "::before").content)).toBe(
          '""',
        );
        const childBounds = await childRow.locator(".subagents-desktop__name").boundingBox();
        const reviewerBounds = await reviewerRow.locator(".subagents-desktop__name").boundingBox();
        expect(childBounds).not.toBeNull();
        expect(reviewerBounds).not.toBeNull();
        expect(reviewerBounds!.y).toBeGreaterThan(childBounds!.y);
        expect(reviewerBounds!.x).toBeGreaterThan(childBounds!.x);
        expect(await surface.locator(`[data-session-key="${unrelated.key}"]`).count()).toBe(0);

        await reviewerRow.locator(".subagents-desktop__open").click();
        await panel
          .getByText("Checking the repair against the original regression.", { exact: true })
          .waitFor();
        expect(page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        expect(await draft.inputValue()).toBe("Keep the parent review draft");
        await panel.getByRole("button", { name: "Back to Subagents", exact: true }).click();
        await reviewerRow
          .getByRole("button", { name: `Stop ${reviewer.label}`, exact: true })
          .click();
        await expectRequestCount(gateway, "sessions.abort", 1);
        expect((await gateway.getRequests("sessions.abort"))[0]?.params).toMatchObject({
          key: reviewer.key,
          agentId: "main",
          runId: "nested-reviewer-run",
        });
        await expectNoRequests(gateway, ["chat.send", "chat.abort"]);

        const added = {
          ...reviewer,
          key: "agent:main:subagent:follow-up-reviewer",
          sessionId: "follow-up-reviewer-session",
          label: "Review the follow-up repair",
          activeRunIds: ["follow-up-reviewer-run"],
          updatedAt: Date.now() + 1,
        } satisfies GatewaySessionRow;
        await gateway.setSessionsListResponse({
          sessions: [parent, child, reviewer, unrelated, added],
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: added.key,
          reason: "create",
          ts: added.updatedAt,
          session: added,
          ancestorSessions: [child, parent],
        });
        const addedRow = surface.locator(`[data-session-key="${added.key}"]`);
        await addedRow.waitFor();
        const siblingRail = surface.locator(".subagents-desktop__branch-rail[data-current-depth]");
        await expect.poll(() => siblingRail.count()).toBe(1);
        await gateway.setSessionsListResponse({ sessions: [parent, child, reviewer, unrelated] });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: added.key,
          sessionId: added.sessionId,
          agentId: "main",
          reason: "delete",
        });
        await expect.poll(() => addedRow.count()).toBe(0);
        expect(await siblingRail.count()).toBe(0);
        await childRow.waitFor();
        await reviewerRow.waitFor();
        expect(await draft.inputValue()).toBe("Keep the parent review draft");
      },
    );
  });
});
