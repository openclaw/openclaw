import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { buildGatewaySessionSnapshot } from "../../../src/gateway/session-event-payload.ts";
import type { GatewaySessionRow } from "../../../src/gateway/session-utils.types.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { CLOUD_PROFILE_RETRY_DELAYS_MS } from "../pages/new-session/cloud-profile-discovery.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { navigateToControlUiSession, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import {
  type createControlUiE2eSuite,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  ONE_PIXEL_PNG_B64,
  NEW_SESSION_MODEL_CATALOG,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  TARGET_REPO,
  WORKSPACE,
  checkoutBaseRefInput,
  controlUiSessionPath,
  controlUiSessionUrl,
  createCloudAgentsListResponse,
  createdSessionListResult,
  expectPendingSessionPlacementStartupBeforeRuntime,
  installMockGateway,
  openEnvironmentPicker,
  pastePng,
  pollAttribute,
  pollCount,
  pollDisabled,
  pollLocatorText,
  pollValue,
  replaceGatewayClient,
  waitForConfirmModal,
} from "./new-session-page.test-support.ts";
import { defineSessionPlacementRecoveryModuleBoundaryTests } from "./session-placement-recovery-module-boundaries.test-support.ts";

export function defineSessionPlacementModuleBoundaryTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
) {
  const timing = (generation: number, updatedAtMs = generation) => ({
    generation,
    createdAtMs: 1,
    updatedAtMs,
    stateChangedAtMs: updatedAtMs,
  });
  const worker = { environmentId: "worker-1", workerBundleHash: "a".repeat(64) };
  const workspace = { workspaceBaseManifestRef: "manifest-1", remoteWorkspaceDir: "/workspace" };
  const activePlacement = {
    state: "active" as const,
    ...timing(5),
    ...worker,
    ...workspace,
    activeOwnerEpoch: 1,
  };
  const popoverOpen = (locator: Locator) =>
    expect.poll(() => locator.evaluate((element) => element.matches(":popover-open")));
  it("dispatches a cloud target before sending its first turn and shows placement", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();
    const runtimeLoad = createDeferred();
    let runtimeRequested = false;
    await page.route(
      moduleRequest("ui/src/app/session-placement-startup.runtime.ts"),
      async (route) => {
        runtimeRequested = true;
        await runtimeLoad.promise;
        await route.continue();
      },
    );
    const sessionKey = "agent:cloud:cloud-e2e";
    const makeRow = (name: string, state: "active" | "local", recency: number) => ({
      key: `agent:cloud:${name.toLowerCase()}-e2e`,
      kind: "direct",
      label: `${name} session`,
      updatedAt: Date.now() - recency,
      placement: { state },
    });
    const initialSessions = createdSessionListResult(sessionKey);
    const initialSession = {
      ...initialSessions.sessions[0],
      key: sessionKey,
      kind: "direct",
      contextTokens: undefined,
      sessionId: "session-cloud-e2e",
      updatedAt: Date.now(),
      placement: { state: "requested", ...timing(1) },
    } satisfies GatewaySessionRow;
    const gateway = await installMockGateway(page, {
      sessions: [initialSession],
      defaultAgentId: "cloud",
      models: NEW_SESSION_MODEL_CATALOG,
      operatorScopes: ["operator.admin", "operator.read", "operator.write"],
      deferredMethods: ["sessions.dispatch"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "projects.list",
        "sessions.create",
        "sessions.dispatch",
        "sessions.reclaim",
      ],
      workspaceGit: true,
      sessionKey: "agent:cloud:neutral-e2e",
      methodResponses: {
        ...LOCAL_GIT_WORKSPACE_RESPONSES,
        "agents.list": createCloudAgentsListResponse(),
        "projects.list": {
          projects: [
            {
              id: "openclaw",
              displayName: "OpenClaw",
              repoRoot: TARGET_REPO,
              source: "registered",
            },
          ],
        },
        "environments.list": {
          environments: [],
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              machines: [
                {
                  id: "standard",
                  label: "Standard",
                  cpu: 32,
                  memoryGb: 64,
                  default: true,
                },
                { id: "fast", label: "Fast", cpu: 64, memoryGb: 128 },
              ],
            },
          ],
        },
        "fs.listDir": {
          path: WORKSPACE,
          parent: "/home/peter",
          home: "/home/peter",
          entries: [],
        },
        "sessions.create": { key: sessionKey },
        "sessions.list": { ...initialSessions, sessions: [initialSession] },
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-cloud-e2e",
          placement: { ...activePlacement, ...timing(1, 2) },
        },
        "sessions.delete": { ok: true, deleted: true },
        "sessions.reclaim": { ok: true },
        "chat.send": { runId: "run-cloud-e2e", status: "started" },
      },
    });
    const profileRequestCount = async () => (await gateway.getRequests("environments.list")).length;

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      expect(
        await page.evaluate(() => ({
          hasSubtleCrypto: Boolean(globalThis.crypto.subtle),
          isSecureContext: globalThis.isSecureContext,
        })),
      ).toEqual({ hasSubtleCrypto: true, isSecureContext: true });
      await gateway.waitForRequest("environments.list");
      const place = page.locator(".oc-popover.new-session-page__where-popover");
      await openEnvironmentPicker(page);
      await place.getByRole("button", { name: "aws", exact: true }).click();
      const trigger = page.locator("#new-session-where-trigger");
      await pollAttribute(trigger, "data-cloud-profile").toBe("aws");
      await place.getByText("Machine", { exact: true }).waitFor();
      await place.locator('[data-value="machine:fast"]').click();
      await pollAttribute(trigger, "data-machine-class").toBe("fast");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("aws");
      expect(await trigger.getAttribute("aria-label")).toContain("aws, Fast");
      await page.keyboard.press("Escape");
      await page.locator("#new-session-project-trigger").click();
      await page.locator('.new-session-page__project-popover [data-value="workspace"]').click();
      const checkoutTrigger = page.locator("#new-session-checkout-trigger");
      const checkout = page.locator(".oc-popover.new-session-page__checkout-popover");
      const checkoutLabel = checkoutTrigger.locator(".new-session-page__trigger-label");
      const checkoutNote = checkout.locator(".new-session-page__menu-note").last();
      await pollAttribute(checkoutTrigger, "data-worktree").toBe("true");
      await pollLocatorText(checkoutLabel).toBe("Starting branch");
      await checkoutTrigger.click();
      const currentCheckout = checkout.locator('[data-value="checkout"]');
      expect(await currentCheckout.isDisabled()).toBe(true);
      expect(await currentCheckout.getAttribute("aria-pressed")).toBe("false");
      expect(await tooltipTitleText(currentCheckout)).toBe("Devices and cloud run in a worktree");
      expect(await checkout.locator('[data-value="worktree"]').getAttribute("aria-pressed")).toBe(
        "true",
      );
      await page.keyboard.press("Escape");

      const controls = page.locator(".new-session-page__composer");
      const effortSelect = controls.locator('[data-chat-thinking-select="true"]');
      await effortSelect.click();
      const thinkingSlider = controls.locator('[data-chat-thinking-slider="true"]');
      await expect.poll(() => thinkingSlider.isVisible()).toBe(true);
      await pollAttribute(thinkingSlider, "data-chat-thinking-values").toBe(
        "off,minimal,low,medium,high",
      );
      const fastMode = controls.locator('[data-chat-speed-option="on"]');
      await pollCount(fastMode).toBe(1);
      await pollAttribute(fastMode, "aria-checked").toBe("false");
      await pollAttribute(fastMode, "role").toBe("radio");
      expect(
        await fastMode.evaluate((element) =>
          element.classList.contains("chat-controls__speed-option"),
        ),
      ).toBe(true);
      await fastMode.click();
      await pollAttribute(fastMode, "aria-checked").toBe("true");
      await pollAttribute(effortSelect, "data-chat-thinking-value").toBe("");
      await thinkingSlider.press("Home");
      await pollAttribute(effortSelect, "data-chat-thinking-value").toBe("off");
      await thinkingSlider.press("End");
      await pollAttribute(effortSelect, "data-chat-thinking-value").toBe("high");
      await effortSelect.click();
      await expect
        .poll(() => effortSelect.evaluate((element) => element.closest("details")?.open ?? false))
        .toBe(false);

      const projectTrigger = page.locator("#new-session-project-trigger");
      const project = page.locator(".oc-popover.new-session-page__project-popover");
      await projectTrigger.click();
      await project.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await pollAttribute(trigger, "data-cloud-profile").toBe("aws");
      await checkoutTrigger.click();
      const baseRef = checkoutBaseRefInput(checkout);
      await pollAttribute(baseRef, "placeholder").toBe("main");
      expect(await baseRef.inputValue()).toBe("");
      await baseRef.fill("release");
      await pollValue(baseRef).toBe("release");
      await pollLocatorText(checkoutLabel).toBe("From release");
      await baseRef.fill("main");
      await pollLocatorText(checkoutNote).toContain("Syncs target-repo to the selected runner");
      await page.keyboard.press("Escape");
      await popoverOpen(checkout).toBe(false);

      await projectTrigger.click();
      await popoverOpen(project).toBe(true);
      await project.getByRole("button", { name: "OpenClaw", exact: true }).click();
      await pollAttribute(projectTrigger, "data-project-id").toBe("openclaw");
      await pollAttribute(trigger, "data-cloud-profile").toBe("aws");
      await checkoutTrigger.click();
      await popoverOpen(checkout).toBe(true);
      await checkout.getByLabel("Name", { exact: true }).fill("cloud-e2e");
      await pollLocatorText(checkoutNote).toContain("Syncs OpenClaw to the selected runner");
      await page.keyboard.press("Escape");

      const message = "fix the cloud-only failure";
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
      await page.getByRole("img", { name: "pixel.png" }).waitFor();
      const startButton = page.getByRole("button", { name: "Start session" });
      await gateway.deferNext("environments.list");
      const profileRequests = await profileRequestCount();
      await replaceGatewayClient(page);
      await expect.poll(profileRequestCount).toBeGreaterThan(profileRequests);
      await pollAttribute(trigger, "data-cloud-profile").toBe("aws");
      await pollDisabled(startButton).toBe(true);
      await gateway.rejectDeferred("environments.list", {
        code: "UNAVAILABLE",
        message: "profile lookup unavailable",
      });
      await pollAttribute(trigger, "data-cloud-profile").toBe("aws");
      await pollDisabled(startButton).toBe(true);
      const failedProfileRequests = await profileRequestCount();
      await expect.poll(profileRequestCount).toBeGreaterThan(failedProfileRequests);
      await pollDisabled(startButton).toBe(false);

      const profileCatalogError = {
        code: "UNAVAILABLE",
        message: "profile catalog remains unavailable",
      };
      await gateway.setMethodResponse("environments.list", { __mockError: profileCatalogError });
      await gateway.deferNext("environments.list");
      const requestsBeforePersistentFailure = await profileRequestCount();
      await gateway.emitGatewayEvent("node.runnerInventory.changed");
      await gateway.waitForRequest("environments.list", {
        after: requestsBeforePersistentFailure,
      });
      await pollDisabled(startButton).toBe(true);
      // Hold each retry's deadline until the next deferred response is installed.
      await pauseVirtualClock(page);
      await gateway.rejectDeferred("environments.list", profileCatalogError);

      // A recorded request is not a processed failure. Let the page settle and
      // schedule its next retry before advancing the clock.
      await pollDisabled(startButton).toBe(false);
      for (const delayMs of CLOUD_PROFILE_RETRY_DELAYS_MS) {
        await gateway.deferNext("environments.list");
        const requestsBeforeRetry = await profileRequestCount();
        await page.clock.fastForward(delayMs + 1);
        await gateway.waitForRequest("environments.list", { after: requestsBeforeRetry });
        await pollDisabled(startButton).toBe(true);
        await gateway.rejectDeferred("environments.list", profileCatalogError);
        await pollDisabled(startButton).toBe(false);
      }
      await page.clock.resume();
      expect(await gateway.getRequests("environments.list")).toHaveLength(
        requestsBeforePersistentFailure + 1 + CLOUD_PROFILE_RETRY_DELAYS_MS.length,
      );
      await pollAttribute(trigger, "data-cloud-profile").toBe("aws");
      await pollAttribute(trigger, "data-machine-class").toBe("fast");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("aws");
      expect(await trigger.getAttribute("aria-label")).toContain("aws, Fast");
      await pollDisabled(startButton).toBe(false);
      await trigger.click();
      const retainedCloudProfile = place.locator('[data-value="cloud:aws"]');
      await pollDisabled(retainedCloudProfile).toBe(false);
      await retainedCloudProfile.click();
      const retainedMachine = place.locator('[data-value="machine:fast"]');
      await expect.poll(() => retainedMachine.isVisible()).toBe(true);
      expect(await retainedMachine.getAttribute("aria-pressed")).toBe("true");
      await page.keyboard.press("Escape");

      // Placement events must render while the initial descriptor is still pending.
      await gateway.deferNext("sessions.describe", { key: sessionKey });
      await startButton.click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "cloud",
        message: "",
        titleSource: message,
        projectId: "openclaw",
        worktree: true,
        worktreeName: "cloud-e2e",
        thinkingLevel: "high",
        fastMode: true,
      });
      expect(create.params).not.toHaveProperty("worktreeBaseRef");
      expect(create.params).not.toHaveProperty("attachments");
      expect(create.params).not.toHaveProperty("cwd");
      await expect.poll(() => runtimeRequested).toBe(true);
      const startupStatus = await expectPendingSessionPlacementStartupBeforeRuntime(
        suite,
        page,
        gateway,
        sessionKey,
      );
      await pollLocatorText(page.locator(".chat-thread")).toContain(message);
      runtimeLoad.resolve();
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toMatchObject({
        key: sessionKey,
        agentId: "cloud",
        profileId: "aws",
        machineClass: "fast",
      });
      await gateway.waitForRequest("sessions.describe", { match: { key: sessionKey } });
      await expect.poll(() => page.url()).toContain(controlUiSessionPath(sessionKey));
      await pollDisabled(page.locator(".agent-chat__composer-combobox textarea")).toBe(false);
      await pollLocatorText(startupStatus).toContain("Provisioning environment…");
      const publishPlacement = async (
        state: "provisioning" | "syncing" | "starting",
        generation: number,
        label: string,
      ) => {
        const placement =
          state === "provisioning"
            ? { state, ...timing(generation) }
            : state === "syncing"
              ? { state, ...timing(generation), ...worker }
              : { state, ...timing(generation), ...worker, ...workspace };
        const now = await page.evaluate(() => Date.now());
        const session = {
          ...initialSession,
          label: "Cloud session",
          status: "running",
          updatedAt: now,
          snapshotAt: now,
          placement,
        } satisfies GatewaySessionRow;
        const sessions = [
          session,
          ...(state === "starting" ? [makeRow("Neutral", "local", 1)] : []),
        ];
        await gateway.setSessionsListResponse({
          sessions,
          ts: Date.now(),
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "cloud",
          reason: "dispatch",
          ts: now,
          ancestorSessions: [],
          ...buildGatewaySessionSnapshot({
            sessionRow: session,
            agentId: "cloud",
          }),
          placement,
          placementMove: null,
        });
        await pollLocatorText(startupStatus).toContain(label);
      };

      const transitions = [
        ["provisioning", 2, "Provisioning environment…"],
        ["syncing", 3, "Preparing workspace…"],
        ["starting", 4, "Starting…"],
      ] as const;
      for (const [state, generation, label] of transitions) {
        await publishPlacement(state, generation, label);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      }
      await gateway.resolveDeferred("sessions.describe", undefined, {
        match: { key: sessionKey },
      });
      await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
      // Child hydration stays bounded independently of placement snapshot delivery.
      const childReads = (await gateway.getRequests("sessions.list")).filter(
        (request) => asNullableRecord(request.params)?.spawnedBy === sessionKey,
      );
      expect(childReads.length).toBeGreaterThan(0);
      expect(childReads.length).toBeLessThanOrEqual(transitions.length + 1);
      await navigateToControlUiSession(page, "agent:cloud:neutral-e2e");
      await expect.poll(() => page.url()).toContain("neutral-e2e");
      await evaluateControlUiContext(
        page,
        (application, pathname) => application.navigate("chat", { pathname }),
        controlUiSessionPath(sessionKey),
      );
      await expect.poll(() => page.url()).toContain(controlUiSessionPath(sessionKey));
      await pollLocatorText(startupStatus).toContain("Starting…");
      expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.dispatch", {
        ok: true,
        key: sessionKey,
        sessionId: "session-cloud-e2e",
        placement: activePlacement,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
      const send = await gateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({
        sessionKey,
        sessionId: "session-cloud-e2e",
        expectedLeafEntryId: null,
        agentId: "cloud",
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      const orderedMethods = (await gateway.getRequests())
        .map((request) => request.method)
        .filter((method) => ["sessions.create", "sessions.dispatch", "chat.send"].includes(method));
      expect(orderedMethods).toEqual(["sessions.create", "sessions.dispatch", "chat.send"]);
      const promptBubbles = page.locator(".chat-group.user .chat-bubble", { hasText: message });
      await pollCount(promptBubbles).toBe(1);

      await gateway.setSessionsListResponse({
        defaults: {},
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            label: "Cloud session",
            sessionId: "session-cloud-e2e",
            status: "running",
            updatedAt: Date.now(),
            worktree: { id: "worktree-1", branch: "openclaw/cloud-e2e", repoRoot: WORKSPACE },
            placement: activePlacement,
          },
          makeRow("Managed", "active", 1),
          makeRow("Local", "local", 2),
          makeRow("Neutral", "local", 3),
        ],
        ts: Date.now(),
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "dispatch" });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:cloud:neutral-e2e"));
      const managedSessionKey = "agent:cloud:managed-e2e";
      const sessionRow = page.locator(`[data-session-key="${managedSessionKey}"]`);
      const localSessionRow = page.locator('[data-session-key="agent:cloud:local-e2e"]');
      await sessionRow.waitFor();
      await localSessionRow.waitFor();
      expect(await sessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      expect(await localSessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      await localSessionRow.click({ button: "right" });
      const sessionMenu = page.getByRole("menu", {
        name: "Actions for Local session",
        exact: true,
      });
      await sessionMenu.waitFor();
      expect(await sessionMenu.getByRole("menuitem", { name: "Stop cloud worker…" }).count()).toBe(
        0,
      );
      await page.keyboard.press("Escape");
      await sessionRow.hover();
      await sessionRow.click({ button: "right" });
      const stopWorker = page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Stop cloud worker…" });
      await stopWorker.waitFor();
      await stopWorker.click();
      await (await waitForConfirmModal(page)).getByRole("button", { name: "Stop worker" }).click();
      const reclaim = await gateway.waitForRequest("sessions.reclaim");
      expect(reclaim.params).toEqual({ key: managedSessionKey, agentId: "cloud" });
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
  defineSessionPlacementRecoveryModuleBoundaryTests(suite, moduleRequest);
}
