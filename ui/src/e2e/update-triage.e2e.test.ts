import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { QUICK_ACTIONS_QUESTION } from "../test-helpers/custodian-quick-actions.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI update failure triage E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const FAILURE = {
  kind: "update",
  status: "error",
  ts: 1_700_000_000_000,
  stats: {
    handoffId: "update-triage-attempt",
    mode: "npm",
    reason: "global-install-failed",
    before: { version: "1.0.0" },
    after: { version: "1.0.0" },
    steps: [
      { name: "install", log: { exitCode: 1, stderrTail: "ENOSPC: no space left on device" } },
    ],
  },
};
const SCHEDULE = {
  channel: "stable",
  autoEnabled: true,
  install: { kind: "package" },
  target: { kind: "package", version: "2.0.0" },
} as const;
const DIAGNOSTIC_REPLY =
  "I will inspect disk space and the recorded install failure before proposing a repair.";

function diagnosticReply(sessionId: string, reply: string) {
  return {
    sequence: [
      { sessionId, reply, action: "none", question: QUICK_ACTIONS_QUESTION },
      { sessionId, reply: DIAGNOSTIC_REPLY, action: "none" },
    ],
  };
}

function questions(traffic: MockGatewayRequest[]) {
  return traffic.filter(
    ({ method, params }) =>
      method === "openclaw.chat" &&
      params !== null &&
      typeof params === "object" &&
      "message" in params,
  );
}

async function expectFailureGuidance(page: Page) {
  const status = page.locator("#config-section-update .settings-status");
  await status.getByText("openclaw triage", { exact: false }).waitFor();
  expect(await status.textContent()).toContain("ENOSPC");
}

async function withTriage(
  options: Parameters<typeof suite.withPage>[0],
  scenario: (page: Page, traffic: MockGatewayRequest[]) => Promise<void>,
) {
  await suite.withPage(
    { ...options, viewport: { height: 1_000, width: 1_400 } },
    async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const traffic = await recordUpdateTraffic(page);
      await scenario(page, traffic);
      expect(errors).toEqual([]);
    },
  );
}

async function recordUpdateTraffic(page: Page): Promise<MockGatewayRequest[]> {
  const traffic: MockGatewayRequest[] = [];
  await page.exposeFunction("recordUpdateTraffic", (request: MockGatewayRequest) => {
    traffic.push(request);
  });
  await page.addInitScript(() => {
    // Mock request logs belong to one document; keep the proof across both
    // stale-chunk recovery and the explicit reload that tests non-replay.
    window.addEventListener("DOMContentLoaded", () => {
      const gatewayWindow = window as unknown as {
        openclawControlUiE2eGateway: { requests: MockGatewayRequest[] };
        recordUpdateTraffic: (request: MockGatewayRequest) => Promise<void>;
      };
      const requests = gatewayWindow.openclawControlUiE2eGateway.requests;
      const record = (request: MockGatewayRequest) => {
        if (request.method === "update.run" || request.method === "openclaw.chat") {
          void gatewayWindow.recordUpdateTraffic(request);
        }
      };
      requests.forEach(record);
      const append = requests.push.bind(requests);
      requests.push = (...added) => {
        added.forEach(record);
        return append(...added);
      };
    });
  });
  return traffic;
}

suite.define(() => {
  it.each(["manual", "automatic", "missing triage module"])(
    "requires a button press to diagnose a pre-ledger %s failure without retrying the update",
    async (source) => {
      await withTriage(
        { colorScheme: "dark", locale: "en-US", serviceWorkers: "block" },
        async (page, traffic) => {
          const dialog = page.locator("openclaw-modal-dialog");
          const panel = page.locator("openclaw-assistant-panel");
          if (source === "missing triage module") {
            // A replaced installation can retire the current document's lazy chunks.
            await page.route(
              controlUiE2eBuiltModuleRequest("ui/src/app/update-triage.runtime.ts"),
              (route) => route.abort("failed"),
            );
          }
          const config = { update: { channel: "stable", auto: { enabled: true } } };
          const gateway = await installMockGateway(page, {
            deferredMethods: ["update.run"],
            featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat"],
            updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
            methodResponses: {
              "config.get": {
                config,
                runtimeConfig: config,
                raw: JSON.stringify(config),
                valid: true,
                hash: "triage-config",
                issues: [],
              },
              "update.status": { sentinel: null, schedule: SCHEDULE },
              "openclaw.chat": diagnosticReply(
                "update-triage-session",
                "I can help you maintain this Gateway.",
              ),
            },
          });
          const readQuestions = () => questions(traffic);
          const updateRuns = () => traffic.filter(({ method }) => method === "update.run");
          expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
          await gateway.waitForRequest("update.status");
          await page.getByRole("button", { name: "Update now", exact: true }).waitFor();
          if (source === "automatic") {
            const now = Date.now();
            await gateway.emitGatewayEvent("update.available", {
              schedule: {
                ...SCHEDULE,
                campaign: {
                  id: "automatic-triage",
                  state: "applying",
                  announcedAtMs: now - 60_000,
                  forceAtMs: now + 900_000,
                  updatedAtMs: now,
                },
              },
            });
            await page.getByText("Applying update…", { exact: true }).waitFor();
          } else {
            await page.getByRole("button", { name: "Update now", exact: true }).click();
            await dialog.getByRole("button", { name: "Update and restart", exact: true }).click();
            await gateway.waitForRequest("update.run");
          }
          await gateway.setMethodResponse("update.status", {
            sentinel: FAILURE,
            schedule: SCHEDULE,
          });
          if (source === "automatic") {
            await gateway.emitGatewayEvent("update.available", { schedule: SCHEDULE });
          } else {
            await gateway.resolveDeferred("update.run", {
              ok: false,
              result: { status: "error", reason: FAILURE.stats.reason },
              sentinel: { payload: FAILURE },
            });
          }
          if (source !== "automatic") {
            await dialog.getByRole("button", { name: "Retry update", exact: true }).waitFor();
            expect(await dialog.textContent()).toContain("ENOSPC");
            await dialog.getByRole("button", { name: "Close", exact: true }).click();
          }
          const diagnose = page.getByRole("button", { name: "Diagnose update", exact: true });
          await diagnose.waitFor();
          expect(await diagnose.isEnabled()).toBe(true);
          expect(await page.locator(".custodian__alert-card").count()).toBe(0);
          expect(readQuestions()).toHaveLength(0);
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
          const replacementDocument =
            source === "missing triage module" ? page.waitForEvent("domcontentloaded") : null;
          await diagnose.click();
          if (source === "missing triage module") {
            // The existing reachable-document recovery reloads once. The final
            // page must retain the cause and host-side guidance if the chunk is still absent.
            await replacementDocument;
            await gateway.waitForRequest("update.status");
            await expectFailureGuidance(page);
            expect(readQuestions()).toHaveLength(0);
            expect(await page.locator(".custodian__alert-card").count()).toBe(0);
          } else {
            await panel
              .locator(".custodian__alert-card")
              .getByText("Diagnose failed update", { exact: true })
              .waitFor();
            await expect.poll(readQuestions).toHaveLength(1);
            const question = readQuestions()[0]?.params;
            expect(question).toMatchObject({ message: expect.stringContaining("ENOSPC") });
            expect(question).toMatchObject({
              message: expect.stringContaining("Do not retry the update"),
            });
            expect(await dialog.count()).toBe(0);
            await panel.getByText(DIAGNOSTIC_REPLY, { exact: true }).waitFor();
            expect(await panel.getByText(DIAGNOSTIC_REPLY, { exact: true }).count()).toBe(1);
          }
          await expect.poll(updateRuns).toHaveLength(source === "automatic" ? 0 : 1);
          if (source !== "missing triage module") {
            // Loading the same retained failure never repeats the user's action.
            await page.reload();
            await gateway.waitForRequest("update.status");
            await expectFailureGuidance(page);
            expect(await page.locator(".custodian__alert-card").count()).toBe(0);
            expect(await panel.locator(".assistant-panel").isVisible()).toBe(false);
            expect(await page.locator("openclaw-assistant-panel-content").count()).toBe(0);
            expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
            expect(readQuestions()).toHaveLength(1);
            expect(updateRuns()).toHaveLength(source === "automatic" ? 0 : 1);
          }
        },
      );
    },
  );

  it.each(["denied", "full"] as const)(
    "diagnoses only on demand even when session storage is %s",
    async (storageFailure) => {
      await withTriage({}, async (page, traffic) => {
        await page.addInitScript((failure) => {
          if (failure === "denied") {
            Object.defineProperty(window, "sessionStorage", {
              get: () => {
                throw new DOMException("Storage denied", "SecurityError");
              },
            });
          } else {
            const session = window.sessionStorage;
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              if (this === session) {
                throw new DOMException("Storage full", "QuotaExceededError");
              }
              Reflect.apply(setItem, this, [key, value]);
            };
          }
        }, storageFailure);
        // The server retains the failure independently of denied browser storage.
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat"],
          methodResponses: {
            "update.status": { sentinel: FAILURE, schedule: SCHEDULE },
            "openclaw.chat": diagnosticReply("storage-failure-session", "Ready to help."),
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        for (let load = 0; load < 2; load += 1) {
          if (load > 0) {
            await page.reload();
          }
          await gateway.waitForRequest("update.status");
          await expectFailureGuidance(page);
          const diagnose = page.getByRole("button", { name: "Diagnose update", exact: true });
          await diagnose.waitFor();
          expect(await page.locator(".custodian__alert-card").count()).toBe(0);
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
          expect(questions(traffic)).toHaveLength(load);
          await diagnose.click();
          const panel = page.locator("openclaw-assistant-panel");
          await panel.getByText(DIAGNOSTIC_REPLY, { exact: true }).waitFor();
          const messages = questions(traffic);
          expect(messages).toHaveLength(load + 1);
          expect(messages.at(-1)?.params).toMatchObject({
            message: expect.stringContaining("ENOSPC"),
          });
          expect(traffic.filter(({ method }) => method === "update.run")).toHaveLength(0);
        }
      });
    },
  );
});
