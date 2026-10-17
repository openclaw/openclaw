import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { AuditRunInspectResult } from "../../../packages/gateway-protocol/src/schema/audit-run.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  expectAttribute,
  expectCount,
  readBox,
  scrollRemainder,
  showHeading,
  showText,
} from "./activity-assertions.test-support.ts";
import {
  decisionDisplay,
  presentResult,
  receiptPage,
} from "./activity-run-inspector.test-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI durable Activity run inspector",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("activity-run-inspector-r6");
  }
});

function ambiguousResult(
  runId: string,
  executionId: string,
  nextExecutionCursor?: string,
): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId, status: "known" },
    identity: {
      state: "ambiguous",
      reasonCode: "execution_selection_required",
      candidates: [
        { executionId, contextId: "candidate-context-safe-ref", createdAt: 1_786_000_000_000 },
      ],
      missingEvidence: ["execution.selection"],
      remediation: [
        {
          code: "select_exact_execution",
          text: "Select one exact execution before inspecting identity evidence.",
        },
      ],
    },
    decisionDisplays: [],
    coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
    ...(nextExecutionCursor ? { nextExecutionCursor } : {}),
  };
}

async function withPage(run: (page: Page) => Promise<void>, options: { video?: boolean } = {}) {
  if (captureUiProof) {
    await mkdir(path.join(proofDir, "video"), { recursive: true });
  }
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 1000, width: 1440 },
    ...(captureUiProof && options.video
      ? { recordVideo: { dir: path.join(proofDir, "video"), size: { height: 1000, width: 1440 } } }
      : {}),
  });
  try {
    await run(await context.newPage());
  } finally {
    await suite.closeBrowserContext(context);
  }
}

function installInspector(page: Page, response: unknown) {
  return installMockGateway(page, {
    featureMethods: ["audit.run.inspect"],
    methodResponses: { "audit.run.inspect": response },
  });
}

async function screenshot(
  page: Page,
  name: string,
  content = page.getByRole("heading", { name: "Identity and authority" }),
) {
  if (!captureUiProof) {
    return;
  }
  if (page.video()) {
    await content.scrollIntoViewIfNeeded();
    await writeFile(
      path.join(proofDir, name),
      await takeControlUiViewportScreenshot(page, page.locator(".run-inspector"), [content]),
    );
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

async function measureWithinAncestor(element: Locator, ancestorSelector: string) {
  return element.evaluate((node, selector) => {
    const ancestor = node.closest<HTMLElement>(selector);
    if (!ancestor) {
      throw new Error(`Expected element inside ${selector}`);
    }
    const elementBounds = node.getBoundingClientRect();
    const ancestorBounds = ancestor.getBoundingClientRect();
    return {
      ancestorBottom: ancestorBounds.bottom,
      ancestorTop: ancestorBounds.top,
      elementBottom: elementBounds.bottom,
      elementTop: elementBounds.top,
    };
  }, ancestorSelector);
}

async function expectReferenceCounts(page: Page, count: string) {
  for (const label of ["Policy references used", "Grant references used"]) {
    expect(
      await page
        .getByText(label, { exact: true })
        .locator("xpath=following-sibling::dd")
        .textContent(),
    ).toBe(count);
  }
}

function approval(
  id: number,
  outcome: Parameters<typeof decisionDisplay>[0]["outcome"],
  reasonCode: string,
  coverageState: Parameters<typeof decisionDisplay>[0]["coverageState"] = "enforced",
) {
  return decisionDisplay({
    id: `approval-decision:${id}`,
    summary: `Approval ${id}`,
    outcome,
    reasonCode,
    coverageState,
    remediation: outcome === "allowed" ? "No follow-up is required." : `Review approval ${id}.`,
  });
}

suite.define(() => {
  it("deep-links, reloads durable evidence, and exposes text-first accessible states", async () => {
    await withPage(
      async (page) => {
        const runId = "run:durable/one";
        const gateway = await installInspector(page, presentResult(runId));
        await page.goto(
          `${suite.server.baseUrl}activity?view=run&run=${encodeURIComponent(runId)}`,
        );
        await showHeading(page, "Identity and authority");
        expect(await gateway.waitForRequest("audit.run.inspect")).toMatchObject({
          params: { runId, decisionLimit: 50, executionLimit: 50 },
        });
        expect((await gateway.getRequests("audit.run.inspect")).length).toBe(1);
        expect(await page.getByRole("tab", { name: "Run inspector" }).count()).toBe(0);
        const modePanel = page.locator("#activity-mode-panel");
        expect(await modePanel.getAttribute("role")).toBeNull();
        expect(await modePanel.getAttribute("aria-labelledby")).toBeNull();
        const backToSessions = page.getByRole("link", { name: "Back to sessions" });
        await backToSessions.waitFor();
        expect(await backToSessions.getAttribute("href")).toBe("/activity");
        await screenshot(page, "01-present-unattributed.png");
        await page.reload();
        await showHeading(page, "Identity and authority");
        expect(await gateway.waitForRequest("audit.run.inspect")).toMatchObject({
          params: { runId, decisionLimit: 50, executionLimit: 50 },
        });
        expect((await gateway.getRequests("audit.run.inspect")).length).toBe(1);
        await backToSessions.click();
        await page.getByRole("tab", { name: "Sessions" }).waitFor();
        expect(await page.getByRole("tab").count()).toBe(2);
        expect(await page.getByRole("tab", { name: "Run inspector" }).count()).toBe(0);
        const liveTab = page.getByRole("tab", { name: "Live activity" });
        await liveTab.focus();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()))
          .toBe("Live activity");
        await page.keyboard.press("Enter");
        await page.locator(".activity-empty").waitFor();
        await expectAttribute(modePanel, "aria-labelledby").toBe("activity-mode-tab-live");
        expect(new URL(page.url()).search).toBe("?view=live");
        await page.goBack();
        await expectAttribute(page.getByRole("tab", { name: "Sessions" }), "aria-selected").toBe(
          "true",
        );
        await page.goBack();
        await showHeading(page, "Identity and authority");
      },
      { video: true },
    );
  });

  it("pages, deep-links, and safely explains approval and unsupported receipts", async () => {
    const privateApprovalReceiptId = "U2_R6_BROWSER_APPROVAL_RECEIPT_ID_SECRET_315c";
    const privateResolutionRef = "U2_R6_BROWSER_RESOLUTION_REF_SECRET_f907";
    const privateMessageReceiptId = "U2_R6_BROWSER_MESSAGE_RECEIPT_ID_SECRET_761e";
    const privateEventId = "U2_R6_BROWSER_EVENT_ID_SECRET_b442";
    const allowed = approval(101, "allowed", "operator_approval_allowed_by_reviewer");
    const denied = approval(102, "denied", "operator_approval_denied_by_reviewer");
    Object.assign(denied, {
      receiptId: privateApprovalReceiptId,
      resolutionRef: privateResolutionRef,
      command: "rm -rf /private/operator-path",
      arguments: { token: "credential-value" },
      payload: "raw-payload",
    });
    const expired = approval(103, "denied", "operator_approval_expired");
    const cancelled = approval(104, "denied", "operator_approval_cancelled_run_aborted");
    const unknown = approval(105, "unknown", "operator_approval_execution_link_missing", "unknown");
    const unsupported = approval(
      106,
      "not-applicable",
      "observation_enforcement_unsupported",
      "unsupported",
    );
    const delivered = decisionDisplay({
      id: "message-decision:2000000000007",
      summary: "An outbound message was delivered.",
      outcome: "allowed",
      reasonCode: "message_delivered",
      coverageState: "attribution-only",
      remediation: "No follow-up is required.",
      producer: "message-delivery",
      family: "message",
      operation: "send",
    });
    Object.assign(delivered, {
      receiptId: privateMessageReceiptId,
      eventId: privateEventId,
    });
    const firstPage = receiptPage([allowed, denied], "a:10:2");
    const secondPage = receiptPage([expired, cancelled, unknown, unsupported, delivered]);
    await withPage(async (page) => {
      await page.addInitScript(() => {
        const recordedUrls: string[] = [];
        const instrument = (method: "pushState" | "replaceState") => {
          const original = history[method].bind(history);
          history[method] = ((data: unknown, unused: string, url?: string | URL | null) => {
            if (url !== undefined && url !== null) {
              recordedUrls.push(String(url));
            }
            original(data, unused, url);
          }) as History[typeof method];
        };
        instrument("pushState");
        instrument("replaceState");
        Object.defineProperty(window, "activityHistoryUrls", { value: recordedUrls });
      });
      const gateway = await installInspector(page, {
        cases: [
          { match: { decisionCursor: "a:10:2" }, response: secondPage },
          { match: { runId: "receipt-matrix" }, response: firstPage },
        ],
      });
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=receipt-matrix`);
      await page.getByRole("list", { name: "Decision receipt list" }).waitFor();
      await showHeading(page, "Receipt detail");
      await page.getByText("Allowed", { exact: true }).first().waitFor();
      await page.getByText("Enforced", { exact: true }).first().waitFor();
      await showText(page, "operator_approval_allowed_by_reviewer");
      await showText(page, "Display provenance");
      await showText(page, "Verified producer");
      await showText(page, "operator-approval");
      await showText(page, "No follow-up is required.");
      await expectReferenceCounts(page, "1");
      const deniedLink = page.getByText(denied.action.summary!, { exact: true }).locator("..");
      await deniedLink.focus();
      await page.keyboard.press("Enter");
      await showText(page, "operator_approval_denied_by_reviewer");
      expect(new URL(page.url()).searchParams.get("receipt")).toBe("approval-decision:102");
      await page.reload();
      await showText(page, "operator_approval_denied_by_reviewer");
      await page.getByRole("button", { name: "Load more receipts" }).click();
      expect((await gateway.getRequests("audit.run.inspect")).at(-1)?.params).toMatchObject({
        runId: "receipt-matrix",
        decisionCursor: "a:10:2",
        decisionLimit: 50,
      });
      await page.getByText(expired.action.summary!, { exact: true }).click();
      await showText(page, "operator_approval_expired");
      const selectedUrl = new URL(page.url());
      expect(selectedUrl.searchParams.get("receipt")).toBe("approval-decision:103");
      expect(selectedUrl.searchParams.get("decision")).toBe("a:10:2");
      await page.reload();
      await showText(page, "operator_approval_expired");
      expect((await gateway.getRequests("audit.run.inspect")).at(-1)?.params).toMatchObject({
        runId: "receipt-matrix",
        decisionCursor: "a:10:2",
        decisionLimit: 50,
      });
      for (const [receipt, reasonCode] of [
        [cancelled, "operator_approval_cancelled_run_aborted"],
        [unknown, "operator_approval_execution_link_missing"],
        [unsupported, "observation_enforcement_unsupported"],
      ] as const) {
        await page.getByText(receipt.action.summary!, { exact: true }).click();
        await showText(page, reasonCode);
      }
      await page.getByText("Unknown", { exact: true }).first().waitFor();
      await page.getByText("Unsupported", { exact: true }).first().waitFor();
      await page.getByText(delivered.action.summary!, { exact: true }).click();
      await showText(page, "message_delivered");
      expect(new URL(page.url()).searchParams.get("receipt")).toBe(
        "message-decision:2000000000007",
      );
      const surfaces = await page.locator("body").evaluate((body) => {
        const elements = [body, ...body.querySelectorAll<HTMLElement>("*")];
        const historyUrls = (window as typeof window & { activityHistoryUrls?: readonly string[] })
          .activityHistoryUrls;
        return {
          // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText separately proves rendered visible text.
          visibleText: body instanceof HTMLElement ? body.innerText : "",
          textContent: body.textContent ?? "",
          aria: elements
            .flatMap((element) =>
              ["aria-label", "aria-labelledby", "aria-describedby", "title", "alt"].map((name) =>
                element.getAttribute(name),
              ),
            )
            .filter((value): value is string => value !== null)
            .join("\n"),
          hrefs: elements
            .filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement)
            .flatMap((link) => [link.getAttribute("href") ?? "", link.href])
            .join("\n"),
          location: location.href,
          historyState: JSON.stringify(history.state),
          historyUrls: [...(historyUrls ?? [])].join("\n"),
        };
      });
      const accessibilityTree = await page.locator("body").ariaSnapshot();
      for (const hidden of [
        "hidden-action-id",
        "hidden-resource-id",
        "hidden-target-id",
        "hidden-evaluator-id",
        "hidden-policy-id",
        "hidden-grant-id",
        "hidden-record-id",
        "rm -rf",
        "/private/operator-path",
        "credential-value",
        "raw-payload",
        privateApprovalReceiptId,
        privateResolutionRef,
        privateMessageReceiptId,
        privateEventId,
      ]) {
        for (const surface of [...Object.values(surfaces), accessibilityTree]) {
          expect(surface).not.toContain(hidden);
        }
      }
      await screenshot(page, "16-receipt-detail-message.png");
    });
  });

  it("renders the Gateway's unverified receipt state without claiming a verified producer", async () => {
    const response = receiptPage([
      {
        schemaVersion: 1,
        selectorId: "decision-fact:1",
        occurredAt: 1_786_000_000_000,
        action: { family: "decision", operation: "record" },
        decision: { outcome: "unknown", reasonCode: "decision_fact_display_unverified" },
        enforcement: {
          coverageState: "unknown",
          policyCount: 0,
          grantCount: 0,
          contextFieldsUsed: [],
        },
        provenance: { state: "unverified" },
        missingEvidence: ["decision.display_provenance"],
        remediation: [],
      },
    ]);

    await withPage(
      async (page) => {
        await installInspector(page, response);
        await page.goto(`${suite.server.baseUrl}activity?view=run&run=receipt-matrix`);
        await showHeading(page, "Receipt detail");
        await page.getByText("Unknown", { exact: true }).first().waitFor();
        await showText(page, "Receipt-controlled explanations and next steps are hidden", false);
        await expectReferenceCounts(page, "0");
        const detail = page.locator(".run-inspector__receipt-detail");
        await showText(detail, "decision_fact_display_unverified");
        await showText(detail, "decision.display_provenance");
        expect(await detail.getByText("Verified producer", { exact: true }).count()).toBe(0);
        await screenshot(
          page,
          "18-unverified-receipt-privacy.png",
          detail.getByText("decision_fact_display_unverified", { exact: true }),
        );
      },
      { video: true },
    );
  });

  it("keeps loaded receipts visible when later-page inspection fails", async () => {
    await withPage(async (page) => {
      await installInspector(page, {
        cases: [
          {
            match: { decisionCursor: "a:10:2" },
            response: {
              __mockError: {
                code: "INVALID_REQUEST",
                message: "decision cursor is no longer retained",
              },
            },
          },
          {
            match: { runId: "receipt-page-error" },
            response: {
              ...receiptPage(
                [
                  decisionDisplay({
                    id: "approval-decision:107",
                    summary: "A denied approval remains visible.",
                    outcome: "denied",
                    reasonCode: "operator_approval_denied_by_reviewer",
                    coverageState: "enforced",
                    remediation: "Review the recorded denial.",
                  }),
                ],
                "a:10:2",
              ),
              run: {
                runId: "receipt-page-error",
                executionId: "execution-safe-ref",
                status: "known",
              },
            },
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=receipt-page-error`);
      await page.getByText("A denied approval remains visible.", { exact: true }).first().waitFor();
      await page.getByRole("button", { name: "Load more receipts" }).click();
      await showText(page.getByRole("alert"), "More receipts could not be loaded", false);
      await page.getByText("A denied approval remains visible.", { exact: true }).first().waitFor();
    });
  });

  it("restarts stale receipt deep links on page one while preserving the exact selector", async () => {
    for (const scenario of [
      { kind: "run", id: "run:stale/deep-link" },
      { kind: "execution", id: "execution:stale/deep-link" },
    ] as const) {
      await withPage(async (page) => {
        const receiptId = `private-receipt-${scenario.kind}`;
        const decisionCursor = `a:1786000000000:${scenario.kind === "run" ? "41" : "42"}`;
        const firstPage = presentResult(
          scenario.kind === "run" ? scenario.id : "run-for-exact-execution",
          scenario.kind === "execution" ? scenario.id : "execution-for-run",
        );
        const gateway = await installInspector(page, {
          cases: [
            {
              match: { decisionCursor },
              response: {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "decision cursor is no longer retained",
                },
              },
            },
            { match: { [`${scenario.kind}Id`]: scenario.id }, response: firstPage },
          ],
        });
        const search = new URLSearchParams({
          view: "run",
          [scenario.kind]: scenario.id,
          receipt: receiptId,
          decision: decisionCursor,
        });
        await page.goto(`${suite.server.baseUrl}activity?${search.toString()}`);
        await showHeading(page, "Run inspection failed");
        const restart = page.getByRole("button", { name: "Restart inspection" });
        await restart.waitFor();
        expect(await page.getByRole("button", { name: "Retry inspection" }).count()).toBe(0);
        const errorText = (await page.locator(".run-inspector__panel").textContent()) ?? "";
        expect(errorText).not.toContain(receiptId);
        expect(errorText).not.toContain(decisionCursor);
        const requestCount = (await gateway.getRequests("audit.run.inspect")).length;
        await restart.focus();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()))
          .toBe("Restart inspection");
        await page.keyboard.press("Enter");
        await showHeading(page, "Identity and authority");
        const request = await gateway.waitForRequest("audit.run.inspect", { after: requestCount });
        const expectedParams = {
          [`${scenario.kind}Id`]: scenario.id,
          decisionLimit: 50,
          ...(scenario.kind === "run" ? { executionLimit: 50 } : {}),
        };
        expect(request.params).toEqual(expectedParams);
        expect(request.params).not.toHaveProperty("decisionCursor");
        const restartedUrl = new URL(page.url());
        expect(restartedUrl.searchParams.get(scenario.kind)).toBe(scenario.id);
        expect(restartedUrl.searchParams.get(scenario.kind === "run" ? "execution" : "run")).toBe(
          null,
        );
        expect(restartedUrl.searchParams.get("receipt")).toBeNull();
        expect(restartedUrl.searchParams.get("decision")).toBeNull();
      });
    }
  });

  it("keeps a populated Live activity stream bounded after adding the mode switcher", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        sessions: [
          { key: "agent:main:main", kind: "direct", hasActiveRun: true, status: "running" },
        ],
      });
      await page.goto(`${suite.server.baseUrl}activity?view=live`);
      await page.locator(".activity-empty").waitFor();
      await gateway.waitForRequest("sessions.messages.subscribe", {
        match: { key: "agent:main:main" },
      });
      for (let index = 0; index < 40; index += 1) {
        await gateway.emitGatewayEvent("agent", {
          runId: `run-layout-${index}`,
          seq: 1,
          stream: "tool",
          ts: Date.now() + index,
          sessionKey: "agent:main:main",
          data: {
            phase: "start",
            name: `layout_tool_${index}`,
            toolCallId: `tool-layout-${index}`,
            args: {},
          },
        });
      }
      const stream = page.locator(".activity-stream");
      await expectCount(page.locator(".activity-entry")).toBe(40);
      const mode = await readBox(page.locator("#activity-mode-panel"));
      const live = await readBox(page.locator("#activity-live-panel"));
      const layout = await readBox(stream);
      const workspace = await readBox(page.locator(".settings-workspace--fill-height"));
      expect({ mode, live }).toMatchObject({
        mode: { display: "flex", flexGrow: "1" },
        live: { display: "flex", flexGrow: "1" },
      });
      expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
      expect(layout.bottom).toBeLessThanOrEqual(workspace.bottom + 1);
      expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
      await stream.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(() => scrollRemainder(stream)).toBeLessThanOrEqual(1);
      await screenshot(page, "13-populated-live-activity.png");
      await page.setViewportSize({ height: 900, width: 720 });
      const mobile = await readBox(page.locator("main.content"));
      expect(mobile.overflowY).toBe("auto");
      expect(await readBox(page.locator("main.content openclaw-router-outlet"))).toMatchObject({
        display: "block",
      });
      expect(await page.locator("main.content .activity-stream").count()).toBe(1);
      expect(mobile.scrollHeight).toBeGreaterThan(mobile.clientHeight);
    });
  });

  it("keeps populated desktop run evidence reachable without taking mobile page scrolling", async () => {
    await withPage(async (page) => {
      const runId = "run:bounded/inspector";
      await page.setViewportSize({ height: 640, width: 900 });
      await installInspector(page, presentResult(runId));
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=${encodeURIComponent(runId)}`);
      const inspector = page.locator(".run-inspector");
      const finalReceiptContent = page.getByText(
        "Treat this receipt as attribution only; it does not prove authorization.",
        { exact: true },
      );
      await finalReceiptContent.waitFor({ state: "attached" });
      const desktopLayout = await readBox(inspector);
      expect(desktopLayout.overflowY).toBe("auto");
      expect(desktopLayout.scrollHeight).toBeGreaterThan(desktopLayout.clientHeight);
      expect(desktopLayout.documentHeight).toBeLessThanOrEqual(desktopLayout.viewportHeight + 1);
      await inspector.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(() => scrollRemainder(inspector)).toBeLessThanOrEqual(1);
      const finalContentPosition = await measureWithinAncestor(
        finalReceiptContent,
        ".run-inspector",
      );
      expect(finalContentPosition.elementTop).toBeGreaterThanOrEqual(
        finalContentPosition.ancestorTop,
      );
      // The 1px integer scroll remainder plus fractional rect rounding permits 2px here.
      expect(finalContentPosition.elementBottom).toBeLessThanOrEqual(
        finalContentPosition.ancestorBottom + 2,
      );
      await screenshot(page, "14-bounded-run-inspector.png");
      await page.setViewportSize({ height: 900, width: 720 });
      const mobile = await readBox(page.locator("main.content"));
      const mobileInspector = await readBox(page.locator("main.content .run-inspector"));
      expect(mobile.overflowY).toBe("auto");
      expect(mobile.scrollHeight).toBeGreaterThan(mobile.clientHeight);
      expect(mobileInspector.scrollHeight).toBeLessThanOrEqual(mobileInspector.clientHeight + 1);
    });
  });

  it("keeps empty selections explicit and pages ambiguous executions", async () => {
    await withPage(async (page) => {
      const gateway = await installInspector(page, {
        cases: [
          {
            match: { runId: "ambiguous", executionCursor: "50" },
            response: ambiguousResult("ambiguous", "execution-candidate-51"),
          },
          {
            match: { runId: "ambiguous" },
            response: ambiguousResult("ambiguous", "execution-candidate-1", "50"),
          },
          {
            match: { executionId: "execution-candidate-1" },
            response: presentResult("ambiguous", "execution-candidate-1"),
          },
          {
            match: { executionId: "execution-candidate-51" },
            response: presentResult("ambiguous", "execution-candidate-51"),
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}activity?view=run`);
      await showHeading(page, "No run selected");
      expect((await gateway.getRequests("audit.run.inspect")).length).toBe(0);
      await screenshot(page, "02-empty.png");
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=ambiguous`);
      await showHeading(page, "Multiple executions match this run");
      await screenshot(page, "11-ambiguous.png");
      await page.getByRole("button", { name: "Load more executions" }).click();
      await page.getByRole("link", { name: "execution-candidate-51" }).waitFor();
      expect((await gateway.getRequests("audit.run.inspect")).at(-1)?.params).toEqual({
        runId: "ambiguous",
        executionCursor: "50",
        decisionLimit: 50,
        executionLimit: 50,
      });
      expect(await page.getByRole("button", { name: "Load more executions" }).count()).toBe(0);
      await page.getByRole("link", { name: "execution-candidate-51" }).click();
      await showHeading(page, "Identity and authority");
      expect(new URL(page.url()).searchParams.get("execution")).toBe("execution-candidate-51");
      expect((await gateway.getRequests("audit.run.inspect")).at(-1)?.params).toEqual({
        executionId: "execution-candidate-51",
        decisionLimit: 50,
      });
      await screenshot(page, "12-exact-selection.png");
    });
  });

  it("shows loading, request failure, retry, and disconnected states", async () => {
    await withPage(async (page) => {
      const runId = "retry-run";
      const gateway = await installMockGateway(page, {
        featureMethods: ["audit.run.inspect"],
        deferredMethods: ["audit.run.inspect"],
        methodResponses: { "audit.run.inspect": presentResult(runId) },
      });
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=${runId}`);
      await showHeading(page, "Loading run inspection");
      await screenshot(page, "06-loading.png");
      await gateway.rejectDeferred("audit.run.inspect", {
        code: "UNAVAILABLE",
        message: "temporarily unavailable",
        retryable: true,
      });
      await showHeading(page, "Run inspection failed");
      await screenshot(page, "07-error.png");
      await page.getByRole("button", { name: "Retry inspection" }).click();
      await showHeading(page, "Identity and authority");
      await gateway.closeLatest(1006, "network unavailable");
      await showHeading(page, "Gateway disconnected");
      await screenshot(page, "08-disconnected.png");
    });
  });

  it("distinguishes missing access from an older unsupported Gateway", async () => {
    for (const scenario of [
      {
        name: "unauthorized",
        featureMethods: ["audit.run.inspect"],
        operatorScopes: ["operator.approvals"],
        heading: "Operator read access required",
        screenshotName: "09-unauthorized.png",
      },
      {
        name: "unsupported",
        featureMethods: ["chat.startup"],
        operatorScopes: ["operator.read"],
        heading: "Run inspection unsupported",
        screenshotName: "10-unsupported-gateway.png",
      },
    ] as const) {
      await withPage(async (page) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [...scenario.featureMethods],
          operatorScopes: [...scenario.operatorScopes],
        });
        await page.goto(`${suite.server.baseUrl}activity?view=run&run=${scenario.name}`);
        await showHeading(page, scenario.heading);
        expect((await gateway.getRequests("audit.run.inspect")).length).toBe(0);
        await screenshot(page, scenario.screenshotName);
      });
    }
  });
});
