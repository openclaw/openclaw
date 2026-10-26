// Phone stale-build proof covers artifact identity, reconnect retention, and service workers.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { polledAttribute, polledText } from "./chat-presentation.test-support.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  closeContext,
  installPhoneRecoveryRequestObserver,
  observeGatewayRequests,
  observeInstalledArtifact,
  phoneProofIdentity,
  resetPhoneRecoveryRequestObserver,
  startPhoneProofServer,
  type PhoneRecoveryObservation,
  type ObservedGatewayRequest,
  waitForObservedGatewayRequest,
  waitForPhoneProofServiceWorker,
} from "./login-gate-e2e.test-support.ts";
import { phoneProofCleanup } from "./phone-stale-build-recovery.test-support.ts";

const proofIdentity = phoneProofIdentity();
const proofBuildId = proofIdentity.expectedRevisionSha
  ? `phone-proof-${proofIdentity.expectedRevisionSha.slice(0, 12)}-${proofIdentity.expectedRevisionSha.slice(12)}-artifact`
  : "phone-proof-local-artifact";
const suite = createControlUiE2eSuite({
  name: "Control UI phone stale-build recovery E2E",
  startServer: () => startPhoneProofServer(proofBuildId),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});
const RETAINED_IMAGE_ALT = "Generated image retained after timeout";
const RETAINED_TIMEOUT_TEXT =
  "Provider timed out after the request started. Retry the turn, or increase its configured timeout.";

function requestsFor<T extends { method: string }>(requests: T[], ...methods: string[]) {
  return requests.filter((request) => methods.includes(request.method));
}
function effects(requests: ObservedGatewayRequest[]) {
  return {
    assignmentMutationCount: requestsFor(requests, "sessions.assignOwner").length,
    modelWakeCount: requestsFor(requests, "chat.send").length,
  };
}
async function expectNoTerminalAdvice(content: Locator) {
  expect(
    await content.evaluate((element) => element.closest("[role='status']")?.textContent ?? ""),
  ).not.toMatch(/openclaw (?:triage|update)|terminal command|run .*terminal/iu);
}

suite.define(() => {
  it.each([
    { serviceWorker: "normal", serviceWorkers: "allow" as const },
    { serviceWorker: "blocked", serviceWorkers: "block" as const },
  ] as const)(
    "keeps repeated build rejection stopped until the visible refresh action with $serviceWorker service-worker state",
    async ({ serviceWorker, serviceWorkers }) => {
      const proofServer = suite.server;
      const context = await suite.browser.newContext({
        hasTouch: true,
        isMobile: true,
        serviceWorkers,
        viewport: { height: 844, width: 390 },
      });
      await using contextCleanup = phoneProofCleanup(() => closeContext(context));
      void contextCleanup;
      const page = await context.newPage();
      const documentRequests: PhoneRecoveryObservation["documentRequests"] = [];
      const documentResponses: PhoneRecoveryObservation["documentResponses"] = [];
      page.on("request", (request) => {
        if (request.resourceType() === "document") {
          const url = new URL(request.url());
          documentRequests.push({
            method: request.method(),
            pathname: url.pathname,
            recoveryMarker: url.searchParams.has("openclaw_mount_recovery"),
            url: url.href,
          });
        }
      });
      page.on("response", (response) => {
        if (response.request().resourceType() === "document") {
          documentResponses.push({
            cacheControl: response.headers()["cache-control"],
            fromWorker: response.fromServiceWorker(),
            requestUrl: response.request().url(),
            status: response.status(),
          });
        }
      });
      await installPhoneRecoveryRequestObserver(
        page,
        controlUiBundledGatewayUrl(proofServer.baseUrl),
      );
      const retainedImageArtifactId = "artifact_phone_proof_generated_image";
      const retainedImagePath =
        "/api/chat/media/outgoing/agent%3Amain%3Amain/phone-proof-generated/full";
      const retainedImageTicketedUrl = `${retainedImagePath}?mediaTicket=phone-proof`;
      const retainedImageBytes = await readFile(
        path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
      );
      const retainedImageRequestUrls: string[] = [];
      // The service worker owns the network request when it controls the page.
      await context.route("**/api/chat/media/outgoing/**", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.searchParams.get("mediaTicket") !== "phone-proof") {
          await route.abort("blockedbyclient");
          return;
        }
        retainedImageRequestUrls.push(requestUrl.href);
        await route.fulfill({ body: retainedImageBytes, contentType: "image/png" });
      });
      const config = { ui: { prefs: { theme: "absolutely", themeMode: "dark" } } };
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, {
        deferredMethods: ["connect"],
        featureMethods: ["chat.startup", "sessions.assignOwner", "users.list"],
        historyMessages: [
          { type: "text", text: RETAINED_TIMEOUT_TEXT },
          {
            type: "image",
            artifactId: retainedImageArtifactId,
            url: retainedImagePath,
            alt: RETAINED_IMAGE_ALT,
            mimeType: "image/png",
            width: 1280,
            height: 358,
          },
        ].map((item, index) => ({ role: "assistant", content: [item], timestamp: index + 1 })),
        serverBuildId: proofBuildId,
        methodResponses: {
          "artifacts.download": {
            artifact: {
              id: retainedImageArtifactId,
              type: "image",
              title: RETAINED_IMAGE_ALT,
              mimeType: "image/png",
              download: { mode: "url" },
            },
            url: retainedImageTicketedUrl,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          "config.get": configSnapshot(config, "phone-recovery-theme"),
          "users.list": {
            profiles: ["Ada", "Bob"].map((displayName) => ({
              id: `profile-${displayName.toLowerCase()}`,
              displayName,
              avatarMime: null,
              mergedInto: null,
              createdAt: 1,
              updatedAt: 1,
              emails: [],
              githubIdentity: null,
              hasAvatar: false,
            })),
          },
        },
        presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
        sessionKey,
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            label: "Main",
            createdActor: { type: "human", id: "profile-bob", label: "Bob" },
            owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
            updatedAt: 1,
          },
        ],
      });
      const expectedRevisionSha = proofIdentity.expectedRevisionSha;
      let expectedConnectOrdinal = 1;
      const observeCurrentArtifact = async () => {
        const documentOrdinal = documentRequests.length;
        const installedArtifact = await observeInstalledArtifact(page);
        if (
          proofIdentity.proofRevision === "head" &&
          expectedRevisionSha &&
          !installedArtifact.buildId?.includes(`-${expectedRevisionSha.slice(0, 12)}-`)
        ) {
          throw new Error(
            `document ${documentOrdinal} loaded ${installedArtifact.buildId ?? "no build"}, expected ${expectedRevisionSha}`,
          );
        }
        return installedArtifact;
      };
      const waitForConnect = async () => {
        await waitForObservedGatewayRequest(page, expectedConnectOrdinal, "connect");
        await gateway.waitForRequest("connect");
        expectedConnectOrdinal += 1;
        await observeCurrentArtifact();
      };
      const mismatch = {
        code: "UNAVAILABLE",
        message: "Control UI updated; reload this page to continue",
        details: {
          code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
        retryable: false,
      };
      const target = new URL("chat/main", proofServer.baseUrl);
      const recovery = page.getByRole("button", { name: /Server updated/u });

      await page.goto(target.href);
      const initialServiceWorker = await waitForPhoneProofServiceWorker(page, serviceWorker);
      expect(initialServiceWorker).toMatchObject({
        controlled: serviceWorker === "normal",
        controllerState: serviceWorker === "normal" ? "activated" : null,
        registrations: serviceWorker === "normal" ? [expect.anything()] : [],
      });
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      const retainedImage = page.getByAltText(RETAINED_IMAGE_ALT);
      const retainedTimeout = page.getByText(RETAINED_TIMEOUT_TEXT, { exact: true });
      const retainedDelivery = async () => {
        await retainedImage.waitFor({ state: "visible", timeout: 10_000 });
        await retainedTimeout.waitFor({ state: "visible", timeout: 10_000 });
        return {
          image: await retainedImage.evaluate(
            (element) => element instanceof HTMLImageElement && element.complete,
          ),
          timeout: await retainedTimeout.isVisible(),
        };
      };
      const beforeReconnect = await retainedDelivery();
      const connectCountBeforeReconnect = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("connect");
      await gateway.closeLatest(1006, "phone proof timeout-delivery reconnect");
      await gateway.waitForRequest("connect", { after: connectCountBeforeReconnect });
      await gateway.resolveDeferred("connect");
      const afterReconnect = await retainedDelivery();
      const retentionRequests = await observeGatewayRequests(page);
      const retentionConnects = requestsFor(retentionRequests, "connect");
      const retentionTranscripts = requestsFor(
        retentionRequests,
        "chat.history",
        "chat.startup",
        "sessions.messages.subscribe",
      );
      const retentionEffects = effects(retentionRequests);
      expect([beforeReconnect, afterReconnect]).toEqual([
        { image: true, timeout: true },
        { image: true, timeout: true },
      ]);
      expect(retentionConnects).toHaveLength(2);
      expect(new Set(retentionConnects.map((request) => request.requestId)).size).toBe(2);
      expect(retentionTranscripts.length).toBeGreaterThanOrEqual(1);
      expect(retentionEffects).toEqual({ assignmentMutationCount: 0, modelWakeCount: 0 });
      const artifactDownloadRequests = await gateway.getRequests("artifacts.download");
      expect(artifactDownloadRequests.length).toBeGreaterThanOrEqual(1);
      expect(retainedImageRequestUrls.length).toBeGreaterThanOrEqual(1);
      for (const requestUrl of retainedImageRequestUrls) {
        const url = new URL(requestUrl);
        expect(url.pathname).toContain("/api/chat/media/outgoing/");
        expect(url.searchParams.get("mediaTicket")).toBe("phone-proof");
      }
      await resetPhoneRecoveryRequestObserver(page);
      documentRequests.length = 0;
      documentResponses.length = 0;
      await gateway.deferNext("connect");
      await page.reload();
      await waitForConnect();
      await gateway.rejectDeferred("connect", mismatch);
      await page.waitForFunction(
        () =>
          JSON.parse(sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId") ?? "null")
            ?.buildId === "replacement-build" &&
          sessionStorage.getItem("openclaw.control-ui-e2e.build-rejection-loads") === "2",
      );

      await waitForConnect();
      await gateway.rejectDeferred("connect", mismatch);
      await recovery.waitFor({ timeout: 10_000 });
      expect(await recovery.count()).toBe(1);
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("#control-ui-main").getAttribute("inert")).toBeNull();
      expect(await page.locator("openclaw-router-outlet").getAttribute("inert")).not.toBeNull();
      const recoveryAccess = await recovery.evaluate((button) => {
        const { height, width } = button.getBoundingClientRect();
        const liveRegion = button.closest<HTMLElement>("[role='status']");
        const outlet = document.querySelector("openclaw-router-outlet");
        return {
          ariaLive: liveRegion?.getAttribute("aria-live"),
          disabled: (button as HTMLButtonElement).disabled,
          height,
          insideFencedOutlet: outlet?.contains(button) ?? false,
          tabIndex: (button as HTMLButtonElement).tabIndex,
          width,
        };
      });
      expect(recoveryAccess).toEqual({
        ariaLive: "polite",
        disabled: false,
        height: expect.any(Number),
        insideFencedOutlet: false,
        tabIndex: 0,
        width: expect.any(Number),
      });
      // Browser layout can represent a CSS 44px target a few millionths below 44.
      const touchTargetRoundingTolerancePx = 0.01;
      expect(recoveryAccess.height).toBeGreaterThanOrEqual(44 - touchTargetRoundingTolerancePx);
      expect(recoveryAccess.width).toBeGreaterThanOrEqual(44 - touchTargetRoundingTolerancePx);
      await recovery.focus();
      const recoveryFocused = await recovery.evaluate(
        (button) => document.activeElement === button,
      );
      expect(recoveryFocused).toBe(true);
      const terminalInvocationCount = (await gateway.getRequests("terminal.open")).length;
      await expectNoTerminalAdvice(recovery);
      expect(terminalInvocationCount).toBe(0);

      const documentCountBeforeFailedProbe = documentRequests.length;
      await page.evaluate(() => {
        const originalFetch = window.fetch.bind(window);
        let remainingFailures = 1;
        window.fetch = async (input, init) => {
          if (remainingFailures > 0 && init?.method === "HEAD") {
            remainingFailures -= 1;
            sessionStorage.setItem("openclaw.control-ui-e2e.failed-refresh-probes", "1");
            return new Response(null, { status: 503 });
          }
          return originalFetch(input, init);
        };
      });
      await recovery.tap();
      await page.waitForFunction(
        () => sessionStorage.getItem("openclaw.control-ui-e2e.failed-refresh-probes") === "1",
      );
      const failedRecovery = page.locator(".sidebar-update-card--floating .sidebar-update-card");
      await expect.poll(() => failedRecovery.getByRole("button").isEnabled()).toBe(true);
      await polledText(failedRecovery).toContain("Retry now");
      await polledText(failedRecovery).toContain(
        "Could not refresh. Check your connection and try again.",
      );
      expect(documentRequests).toHaveLength(documentCountBeforeFailedProbe);
      await expectNoTerminalAdvice(failedRecovery);

      await recovery.tap();
      await expect.poll(() => documentRequests.length).toBe(3);
      expect(documentRequests.map((request) => request.recoveryMarker)).toEqual([
        false,
        true,
        true,
      ]);

      await waitForConnect();
      await page.clock.install();
      await pauseVirtualClock(page);
      // A repeated rejection must remain actionable instead of reloading forever.
      await gateway.rejectDeferred("connect", mismatch);
      await page.clock.runFor(120_000);
      expect(documentRequests).toHaveLength(3);
      await page.clock.resume();
      await recovery.tap();
      await expect.poll(() => documentRequests.length).toBe(4);
      await waitForConnect();
      await gateway.resolveDeferred("connect");

      await page.locator("openclaw-app-shell").waitFor();
      expect(documentRequests.map((request) => request.recoveryMarker)).toEqual([
        false,
        true,
        true,
        true,
      ]);
      expect(await recovery.count()).toBe(0);
      await polledAttribute(page.locator("openclaw-router-outlet"), "inert").toBeNull();
      await waitForControlUiRoute(page, { pathname: "/chat/main", routeId: "chat" });
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem("openclaw.control-ui-e2e.build-rejection-loads"),
        ),
      ).toBe("4");
      await expect.poll(() => documentResponses.length).toBe(4);
      expect(documentResponses).toHaveLength(4);
      for (const response of documentResponses) {
        expect(response).toMatchObject({
          cacheControl: "no-cache",
          fromWorker: serviceWorker === "normal",
          status: 200,
        });
      }
      const installedArtifact = await observeCurrentArtifact();
      expect(installedArtifact.buildId).not.toBeNull();
      expect(installedArtifact).toMatchObject({
        bodyDisplay: "block",
        icon: { pathname: "/favicon.svg" },
        font: { pathname: "/fonts/space-grotesk.css" },
        theme: { pathname: "/themes/absolutely.css" },
      });
      for (const asset of [
        installedArtifact.icon,
        installedArtifact.font,
        installedArtifact.theme,
      ]) {
        expect(asset.url).not.toBeNull();
        expect(asset.version).toBe(installedArtifact.buildId);
      }
      const actions = page.getByRole("button", { name: "Actions for Main" });
      await actions.tap();
      const assignment = page.getByRole("menuitem", { name: "Assign to", exact: true });
      await assignment.waitFor();
      await assignment.tap();
      const assignmentPage = page.locator(
        '.chat-mobile-host__page[data-mobile-page="session-assign"]:visible',
      );
      const selectedOwner = assignmentPage.getByRole("button", {
        pressed: true,
        exact: true,
        name: "Bob",
      });
      await selectedOwner.waitFor();
      const selectedOwners = await assignmentPage
        .getByRole("button", { pressed: true })
        .evaluateAll((owners) =>
          owners.map(
            (owner) =>
              owner.querySelector(":scope > span:not([aria-hidden])")?.textContent?.trim() ?? "",
          ),
        );
      expect(selectedOwners).toEqual(["Bob"]);
      const observedGatewayRequests = await observeGatewayRequests(page);
      const connectRequests = requestsFor(observedGatewayRequests, "connect");
      expect(connectRequests).toHaveLength(4);
      expect(connectRequests.map((request) => request.documentOrdinal)).toEqual([1, 2, 3, 4]);
      expect(new Set(connectRequests.map((request) => request.requestId)).size).toBe(4);
      const assignmentEffects = effects(observedGatewayRequests);
      expect(assignmentEffects).toEqual({ assignmentMutationCount: 0, modelWakeCount: 0 });
    },
  );
});
