import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { errors, type Locator, type Page } from "playwright";
import { expect } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  evaluateControlUiContext,
  getControlUiContextHandle,
} from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway as installControlUiMockGateway,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
  waitForConfirmModal,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

export { controlUiSessionPath, controlUiSessionUrl, waitForConfirmModal };

export function installMockGateway(
  page: Page,
  scenario: ControlUiMockGatewayScenario = {},
): Promise<MockGatewayControls> {
  return installControlUiMockGateway(page, {
    ...scenario,
    featureMethods: scenario.featureMethods ?? [
      "agent.wait",
      "chat.metadata",
      "chat.startup",
      "sessions.create",
      "sessions.dispatch",
    ],
  });
}

// The scale-in animation moves inventory rows after they first become visible.
// Wait for its public completion event before hovering a nested details card.
export async function openEnvironmentPicker(page: Page) {
  const afterShow = page.locator(".oc-popover.new-session-page__where-popover").evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener("overlay-after-show", () => resolve(), { once: true });
      }),
  );
  await page.locator("#new-session-where-trigger").click();
  await afterShow;
}

export function checkoutBaseRefInput(scope: Page | Locator): Locator {
  return scope
    .getByRole("combobox", { name: "From", exact: true })
    .or(scope.getByRole("textbox", { name: "From", exact: true }));
}

export const NEW_SESSION_MODEL_CATALOG = [
  { id: "gpt-5.5", name: "GPT 5.5", provider: "openai" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
].map(({ id, name, provider }) => ({
  id,
  name,
  provider,
  reasoning: true,
  thinkingLevels: ["off", "minimal", "low", "medium", "high"].map((level) => ({
    id: level,
    label: level,
  })),
  thinkingDefault: "medium",
}));

export const WORKSPACE = "/home/peter/openclaw";

function workspaceAgents(id: string, name: string) {
  return {
    agents: [{ id, identity: { name }, name, workspace: WORKSPACE, workspaceGit: true }],
    defaultId: id,
    mainKey: "main",
    scope: "agent",
  };
}

export const createCloudAgentsListResponse = () => workspaceAgents("cloud", "Cloud");

export const LOCAL_GIT_WORKSPACE_RESPONSES = {
  "agents.list": workspaceAgents("main", "Main"),
  "worktrees.branches": {
    branches: [{ kind: "local", name: "main" }],
    defaultBranch: "main",
    repositoryStatus: "git",
  },
};
export const PICKED = "/home/peter/openclaw/packages";
export const SOURCE_REPO = "/tmp/source-repo";
export const TARGET_REPO = "/tmp/target-repo";
export const REFRESHED_RESEARCH_WORKSPACE = "/home/peter/research-next";
export const MOVED_WORKSPACE = "/home/peter/openclaw-next";

export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

type NewSessionProofSurface = { surface: Locator; content: readonly Locator[] };

export const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
export const SESSION_LIST_DEFAULTS = {
  contextTokens: null,
  model: "gpt-5.5",
  modelProvider: "openai",
};

export const pollText = (locator: Locator) => expect.poll(() => locator.textContent());
export const pollValue = (locator: Locator) => expect.poll(() => locator.inputValue());
export const pollCount = (locator: Locator) => expect.poll(() => locator.count());
export const pollDisabled = (locator: Locator) => expect.poll(() => locator.isDisabled());
export const pollEnabled = (locator: Locator) => expect.poll(() => locator.isEnabled());
export const pollAttribute = (locator: Locator, name: string) =>
  expect.poll(() => locator.getAttribute(name));

export function pollLocatorText(locator: Locator) {
  return expect.poll(
    async () => {
      try {
        return await locator.textContent({ timeout: 500 });
      } catch (error) {
        if (error instanceof errors.TimeoutError) {
          return null;
        }
        throw error;
      }
    },
    { timeout: 10_000 },
  );
}

export function createNewSessionPageE2eSuite() {
  return createControlUiE2eSuite({
    name: "Control UI new-session page mocked Gateway E2E",
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is unavailable at ${executablePath}`,
  });
}

export async function expectDecodedThumbnail(image: Locator, expectedNaturalWidth?: number) {
  await image.waitFor({ state: "visible" });
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      image.evaluate(async (element: HTMLImageElement, expectedWidth) => {
        await element.decode();
        const bounds = element.getBoundingClientRect();
        return (
          (expectedWidth === undefined || element.naturalWidth === expectedWidth) &&
          Math.min(element.naturalWidth, element.naturalHeight, bounds.width, bounds.height) >=
            32 &&
          bounds.top >= 0 &&
          bounds.left >= 0 &&
          bounds.bottom <= window.innerHeight &&
          bounds.right <= window.innerWidth
        );
      }, expectedNaturalWidth),
    )
    .toBe(true);
}

export async function expectPastedPngImage(image: Locator) {
  await image.waitFor({ state: "visible" });
  const decoded = await image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const bytes = new Uint8Array(await (await fetch(element.currentSrc)).arrayBuffer());
    return {
      width: element.naturalWidth,
      height: element.naturalHeight,
      base64: btoa(String.fromCharCode(...bytes)),
    };
  });
  expect(decoded).toEqual({ width: 1, height: 1, base64: ONE_PIXEL_PNG_B64 });
}

export async function expectPendingNewSessionPresentation(page: Page) {
  const presentation = await page.locator(".new-session-page__starting").evaluate((thread) => {
    const user = thread.querySelector<HTMLElement>(".chat-group.user")!;
    const bubble = user.querySelector<HTMLElement>(".chat-bubble")!;
    const text = bubble.classList.contains("chat-bubble--with-images")
      ? bubble.querySelector<HTMLElement>(".chat-text")!
      : bubble;
    const claw = thread.querySelector<SVGElement>(".chat-reading-indicator svg")!;
    const textStyle = getComputedStyle(text);
    const clawStyle = getComputedStyle(claw);
    return {
      direction: getComputedStyle(user).flexDirection,
      width: thread.getBoundingClientRect().width,
      rightGap: Math.abs(user.getBoundingClientRect().right - bubble.getBoundingClientRect().right),
      padding: [textStyle.paddingTop, textStyle.paddingRight],
      images: bubble.classList.contains("chat-bubble--with-images"),
      background: textStyle.backgroundColor,
      clawSize: [clawStyle.width, clawStyle.height],
      animation: clawStyle.animationName,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
  expect(presentation).toMatchObject({
    direction: "row-reverse",
    clawSize: ["18px", "18px"],
    padding: presentation.images ? ["10px", "14px"] : ["16px", "16px"],
  });
  expect(presentation.width).toBeLessThanOrEqual(768);
  expect(presentation.rightGap).toBeLessThanOrEqual(1);
  expect(presentation.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(presentation.animation).toEqual(
    presentation.reducedMotion ? "none" : expect.stringContaining("chatWorkingClawFlex"),
  );
  return presentation;
}

export function createdSessionListResult(sessionKey: string) {
  return {
    count: 1,
    defaults: SESSION_LIST_DEFAULTS,
    path: "",
    sessions: [
      {
        ...SESSION_LIST_DEFAULTS,
        displayName: "Created session",
        key: sessionKey,
        kind: "direct",
        totalTokens: 0,
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

export async function expectPendingSessionPlacementStartupBeforeRuntime(
  owner: { readonly artifactDir: string },
  page: Page,
  gateway: MockGatewayControls,
  sessionKey: string,
) {
  await waitForCommittedChatRoute(page);
  expect(page.url()).toContain(controlUiSessionPath(sessionKey));
  const startupStatus = page.locator('.chat-thread .chat-working-indicator[role="status"]');
  await pollCount(startupStatus).toBe(1);
  await pollLocatorText(startupStatus).toContain("Provisioning environment…");
  expect(await page.locator(".chat-cloud-startup, .agent-chat__composer-status-band").count()).toBe(
    0,
  );
  await pollDisabled(page.locator(".agent-chat__composer-combobox textarea")).toBe(false);
  expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  await captureUiProof(owner, page, "02-cloud-startup-chunk-pending.png");
  return startupStatus;
}

function proofCapture(directory: string) {
  return async (
    owner: { readonly artifactDir: string },
    page: Page,
    fileName: string,
    presentation?: NewSessionProofSurface,
  ) => {
    if (captureUiProofEnabled) {
      await captureProof(page, path.join(owner.artifactDir, directory), fileName, presentation);
    }
  };
}

export const captureUiProof = proofCapture("cloud-worker-session");
export const captureProjectUiProof = proofCapture("project-registry");
export const captureDeviceRuntimeUiProof = proofCapture("device-runtime-gating");

export async function captureEnvironmentMetadataUiProof(
  owner: { readonly artifactDir: string },
  page: Page,
) {
  const proofName = process.env.OPENCLAW_ENVIRONMENT_METADATA_PROOF;
  if (proofName !== "before" && proofName !== "after") {
    return;
  }
  await captureProof(
    page,
    path.join(owner.artifactDir, "environment-metadata"),
    `${proofName}.png`,
  );
}

async function captureProof(
  page: Page,
  artifactDir: string,
  fileName: string,
  presentation?: NewSessionProofSurface,
) {
  await mkdir(artifactDir, { recursive: true });
  const screenshot = page.video()
    ? await takeControlUiViewportScreenshot(
        page,
        presentation?.surface ?? page.locator(".shell"),
        presentation?.content ?? [
          page
            .locator(
              ".new-session-page__message:visible, .new-session-page__starting .chat-group.user:visible, .agent-chat__composer-combobox textarea:visible",
            )
            .first(),
        ],
      )
    : await page.screenshot({ animations: "disabled", fullPage: true });
  await writeFile(path.join(artifactDir, fileName), screenshot);
}

export async function pastePng(target: Locator, count = 1) {
  await target.evaluate(
    (element, { base64, fileCount }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const clipboard = new DataTransfer();
      for (let index = 0; index < fileCount; index += 1) {
        const fileName = fileCount === 1 ? "pixel.png" : `pixel-${index + 1}.png`;
        clipboard.items.add(new File([bytes], fileName, { type: "image/png" }));
      }
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
    },
    { base64: ONE_PIXEL_PNG_B64, fileCount: count },
  );
}

export async function waitForCommittedNewSessionDraft(
  page: Page,
  expectedText: string | null,
  expectedAttachments: number | readonly string[],
): Promise<void> {
  const params = new URL(page.url()).searchParams;
  const scopeKey = JSON.stringify(
    ["agent", "catalog", "group"].map((key) => params.get(key)?.trim() ?? ""),
  );
  await waitForCommittedComposerDraft(page, scopeKey, expectedText, expectedAttachments);
}

export async function waitForGatewayRecoveryScope(page: Page, ready = true) {
  const application = await getControlUiContextHandle(page);
  try {
    await page.waitForFunction(
      ({ context, expected }) => context.gateway.snapshot.client?.recoveryScopeReady === expected,
      { context: application, expected: ready },
    );
  } finally {
    await application.dispose();
  }
}

export async function replaceGatewayClient(page: Page) {
  await evaluateControlUiContext(page, (context) => context.gateway.connect());
}

export async function navigateInApp(
  page: Page,
  routeId: Parameters<ApplicationContext["navigate"]>[0],
  search = "",
) {
  await evaluateControlUiContext(
    page,
    (context, target) => context.navigate(target.routeId, { search: target.search }),
    { routeId, search },
  );
}

// Router match and URL must agree after Chat's two-stage path commit.
export async function waitForCommittedChatRoute(page: Page) {
  await waitForControlUiRoute(page, { pathnamePrefix: "/chat/", routeId: "chat" });
}

export async function choosePackagesFolder(page: Page) {
  await page.locator("#new-session-project-trigger").click();
  await page.getByRole("button", { name: "Browse folders" }).click();
  await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
}
