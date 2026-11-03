import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiElementScreenshot,
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  pauseVirtualClock,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { defineControlUiFrameIdentityTests } from "./control-ui-screenshot-identity.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI initial connect splash E2E",
  trackBrowserContexts: true,
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  unavailableMessage: (executablePath) =>
    "Playwright Chromium is not installed or cannot start at " + executablePath,
});
const viewport = { height: 900, width: 1280 };

async function createPage(
  options: BrowserContextOptions = { locale: "en-US", viewport },
  timeout = true,
): Promise<Page> {
  const context = await suite.newBrowserContext(options);
  const page = await context.newPage();
  // Synthetic capture pages retain Playwright's original 30-second default.
  page.setDefaultTimeout(timeout ? controlUiE2eWaitTimeoutMs : 30_000);
  return page;
}

function decodeProofPng(png: Buffer) {
  const image = photon.PhotonImage.new_from_byteslice(png);
  try {
    return { width: image.get_width(), height: image.get_height(), data: image.get_raw_pixels() };
  } finally {
    image.free();
  }
}

const createPageWithoutRecording = () => createPage({ locale: "en-US" }, false);

async function connect(page: Page, hash = "") {
  const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
  await page.goto(suite.server.baseUrl + hash, { waitUntil: "domcontentloaded" });
  await gateway.waitForRequest("connect");
  return gateway;
}

async function resolveConnect(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await gateway.resolveDeferred("connect");
  await page.locator("openclaw-app-shell").waitFor();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

async function proofContentPainted(page: Page, proof: Buffer, content: Locator): Promise<boolean> {
  const contentBounds = await content.boundingBox();
  expect(contentBounds).not.toBeNull();
  return page.evaluate(
    async ({ png, bounds }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const crop = document.createElement("canvas");
      crop.width = bounds.width;
      crop.height = bounds.height;
      const context = crop.getContext("2d")!;
      context.drawImage(image, -bounds.x, -bounds.y);
      const pixels = context.getImageData(0, 0, crop.width, crop.height).data;
      // Reject a flat (or effectively invisible) crop without fixing the pose or palette.
      return pixels.some(
        (value, index) => index % 4 !== 3 && Math.abs(value - pixels[index % 4]!) > 10,
      );
    },
    { png: proof.toString("base64"), bounds: contentBounds! },
  );
}

type LoginTraceWindow = Window & { openclawLoginGateMountTrace?: { mounted: boolean } };
async function traceLoginGateMounts(page: Page) {
  await page.addInitScript(() => {
    const trace = { mounted: false };
    (window as LoginTraceWindow).openclawLoginGateMountTrace = trace;
    new MutationObserver((records) => {
      if (
        records.some(({ addedNodes }) =>
          [...addedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.localName === "openclaw-login-gate" ||
                node.querySelector("openclaw-login-gate")),
          ),
        )
      ) {
        trace.mounted = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(() => (window as LoginTraceWindow).openclawLoginGateMountTrace?.mounted ?? false);
}
suite.define(() => {
  it("shows the splash instead of the login gate while a configured token connects", async () => {
    const page = await createPage();
    await page.addInitScript(() => {
      localStorage.setItem(
        `openclaw.control.settings.v1:ws://${location.hostname}:18789`,
        JSON.stringify({ theme: "rose", themeMode: "dark" }),
      );
    });
    const loginGateMounted = await traceLoginGateMounts(page);
    const loginModuleRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/login-gate(?:\.runtime)?\.ts(?:\?|$)/u.test(request.url())) {
        loginModuleRequests.push(request.url());
      }
    });
    const gateway = await connect(page, "#token=e2e-shared-token");
    const splash = page.locator(".connect-splash");
    await splash.waitFor();
    const skeleton = splash.locator(".loading-skeleton");
    await skeleton.waitFor();
    expect(await splash.getAttribute("aria-busy")).toBeNull();
    expect(await splash.locator("openclaw-mascot").count()).toBe(0);
    expect(await page.getByText("Loading panel", { exact: true }).count()).toBe(0);
    expect(await page.locator("openclaw-app-sidebar").count()).toBe(0);
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    const proof = await takeControlUiViewportScreenshot(
      page,
      page.locator(".connect-splash, .shell"),
      [skeleton.locator(".loading-skeleton__composer")],
    );
    const painted = await proofContentPainted(page, proof, skeleton);
    expect(painted, "connecting proof must contain the skeleton").toBe(true);
    const composer = skeleton.locator(".loading-skeleton__composer");
    expect(await page.locator("html").getAttribute("data-theme")).toBe("rose");
    expect(
      await splash.evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
    expect(await composer.evaluate((element) => getComputedStyle(element, "::after").content)).toBe(
      "none",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await splash.locator(".connect-splash__sidebar").isVisible()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await composer.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element, "::after").animationDuration),
      ),
    ).toBeLessThanOrEqual(0.00001);
    expect(
      await splash.evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await resolveConnect(page, gateway);
    expect(await page.locator(".connect-splash").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
    expect(loginModuleRequests).toEqual([]);
  });

  it("keeps the chat placeholder pixels stable through app and route loading", async () => {
    const page = await createPage({ locale: "en-US", viewport, colorScheme: "light" });
    let chatModuleRequested = false;
    const entryModule = createDeferredCore();
    const chatModule = createDeferredCore();
    await page.route(`${new URL(suite.server.baseUrl).origin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/src/main.ts")) {
        await entryModule.promise;
      }
      if (pathname.endsWith("/chat-page.tsx")) {
        chatModuleRequested = true;
        await chatModule.promise;
      }
      await route.continue();
    });
    // The held chat module cannot publish the foreground readiness that releases the roster.
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      deferredMethods: ["connect"],
    });
    const artifactDir = createControlUiE2eArtifactDir("boot-placeholder-parity");
    const placeholderFrame = async (root: Locator, phase: string) => {
      const skeleton = root.locator(".loading-skeleton");
      const label = root.locator(".connect-splash__status");
      expect(await label.textContent()).toBe("Loading…");
      const png = await takeControlUiElementScreenshot(page, skeleton, [skeleton, label]);
      await writeFile(path.join(artifactDir, `${phase}.png`), png);
      // The live composer remains part of the frame without placeholder decoration.
      const geometry = await skeleton.evaluate((element) =>
        [element, ...element.querySelectorAll(".skeleton, .loading-skeleton__composer")].map(
          (node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { x, y, width, height };
          },
        ),
      );
      return { png: decodeProofPng(png), geometry, label: await label.boundingBox() };
    };

    try {
      await page.goto(`${suite.server.baseUrl}chat?session=main`, { waitUntil: "commit" });
      const initial = await placeholderFrame(page.locator("#openclaw-boot-shell"), "document");
      entryModule.resolve();
      await gateway.waitForRequest("connect");
      const connecting = await placeholderFrame(page.locator(".connect-splash"), "connecting");
      expect(connecting.geometry).toEqual(initial.geometry);
      expect(connecting.label).toEqual(initial.label);
      expect(
        Buffer.from(connecting.png.data).equals(Buffer.from(initial.png.data)),
        "connection loading preserves the document placeholder pixels",
      ).toBe(true);
      await gateway.resolveDeferred("connect");
      await page.locator("openclaw-app-shell").waitFor();
      await expect.poll(() => chatModuleRequested).toBe(true);

      const loadingState = page.locator(".lazy-view-state--loading");
      await loadingState.waitFor();
      expect(await loadingState.getAttribute("role")).toBe("status");
      expect(await loadingState.getAttribute("aria-label")).toBe("Loading…");
      expect((await loadingState.textContent())?.trim()).toBe("Loading…");
      expect(await page.getByText("Loading panel", { exact: true }).count()).toBe(0);

      const skeleton = loadingState.locator(".loading-skeleton");
      await skeleton.waitFor();
      expect(await loadingState.getAttribute("aria-busy")).toBeNull();
      expect(await loadingState.locator("openclaw-mascot").count()).toBe(0);
      const routeLoading = await placeholderFrame(loadingState, "route");
      expect(routeLoading.geometry).toEqual(initial.geometry);
      expect(routeLoading.label).toEqual(initial.label);
      expect(
        Buffer.from(routeLoading.png.data).equals(Buffer.from(initial.png.data)),
        "route loading preserves the document placeholder pixels",
      ).toBe(true);
      expect(
        await skeleton.evaluate((element) => element.getAnimations({ subtree: true }).length),
      ).toBe(0);

      for (const size of [viewport, { width: 1440, height: 1440 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(size);
        const { content, header, composer } = await page
          .locator(".content--chat")
          .evaluate(async (root, viewportHeight) => {
            // setViewportSize resolves before the rendering update in which the shell viewport
            // owner publishes the new canvas height; until then a grown viewport keeps the old one.
            const canvas = document.querySelector("openclaw-app")!;
            await new Promise<void>((resolve) => {
              const observer = new ResizeObserver(() => {
                if (canvas.getBoundingClientRect().height === viewportHeight) {
                  observer.disconnect();
                  resolve();
                }
              });
              observer.observe(canvas);
            });
            const bounds = (element: Element | null) => {
              if (!element?.checkVisibility({ visibilityProperty: true })) {
                return null;
              }
              const { x, y, width, height } = element.getBoundingClientRect();
              return width > 0 && height > 0 ? { x, y, width, height } : null;
            };
            return {
              content: bounds(root),
              header: bounds(root.querySelector(".loading-skeleton__header")),
              composer: bounds(root.querySelector(".loading-skeleton__composer")),
            };
          }, size.height);
        expect([content, header, composer]).not.toContain(null);
        expect(header!.y - content!.y, "loading header stays at the top").toBeGreaterThanOrEqual(0);
        expect(header!.y - content!.y, "loading header stays at the top").toBeLessThan(48);
        const bottomGap = content!.y + content!.height - composer!.y - composer!.height;
        expect(bottomGap, "loading composer stays inside the content area").toBeGreaterThanOrEqual(
          0,
        );
        expect(bottomGap, "loading composer stays near the bottom").toBeLessThan(64);
      }
      await page.setViewportSize(viewport);

      chatModule.resolve();
      await page.locator("openclaw-chat-page").waitFor();
      expect(await loadingState.count()).toBe(0);
    } finally {
      entryModule.resolve();
      chatModule.resolve();
    }
  });

  it("redirects before setup detection without loading the discarded workspace", async () => {
    const page = await createPage();
    await page.emulateMedia({ colorScheme: "dark" });
    const workspaceModules = new Set([
      "/src/components/app-sidebar.tsx",
      "/src/components/browser/browser-panel.ts",
      "/src/components/assistant-panel-content-solid.tsx",
      "/src/pages/debug/debug-overlay-content.ts",
      "/src/components/desktop/desktop-panel-solid.tsx",
      "/src/components/terminal/terminal-panel-registration.tsx",
      "/src/pages/chat/chat-page.tsx",
    ]);
    const requestedWorkspaceModules = new Set<string>();
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (workspaceModules.has(pathname)) {
        requestedWorkspaceModules.add(pathname);
      }
    });
    const gateway = await installMockGateway(page, {
      agentModel: null,
      deferredMethods: ["openclaw.setup.detect"],
      featureMethods: [
        "browser.request",
        "desktop.observe",
        "openclaw.chat",
        "openclaw.setup.detect",
        "openclaw.setup.prepare.start",
        "terminal.open",
      ],
      terminalEnabled: true,
    });

    await page.goto(suite.server.baseUrl);
    await page.waitForURL("**/settings/model-setup?firstRun=1");
    expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
    await gateway.waitForRequest("openclaw.setup.detect");
    expect(await gateway.getRequests("openclaw.setup.detect")).toHaveLength(1);
    const loading = page.getByText("Checking this Gateway for available AI access…", {
      exact: true,
    });
    await loading.waitFor();
    const loadingSections = page.locator('.model-setup__loading[role="status"][aria-busy="true"]');
    await loadingSections.locator(".model-setup__loading-sections").waitFor();
    expect(await loadingSections.locator(".settings-section").count()).toBe(5);
    expect(await loadingSections.locator(".model-setup__loading-row").count()).toBe(5);
    expect(await loadingSections.locator("button, input, wa-dropdown").count()).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    // Compare section layouts at rest, not the shell's translated entrance frame.
    await waitForControlUiProofSurface(page.locator(".shell"), [loadingSections]);
    const sectionTitles = [
      "Use an installed agent",
      "Found on this Gateway",
      "Run a model locally",
      "Set up and verify a model",
      "Connect with an API key or token",
    ];
    const loadingGeometry = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        '.model-setup__loading[role="status"][aria-busy="true"]',
      );
      if (!root?.checkVisibility()) {
        throw new Error("Expected the model-setup loading sections to remain visible.");
      }
      return Array.from(root.querySelectorAll(".model-setup__loading-sections h2"), (heading) => {
        const { top, height } = heading.getBoundingClientRect();
        return { title: heading.textContent, top, height };
      });
    });
    expect(loadingGeometry.map((heading) => heading.title)).toEqual(sectionTitles);
    expect(loadingGeometry.every((heading) => heading.height > 0)).toBe(true);
    const loadingSectionTops = loadingGeometry.map((heading) => heading.top);
    expect(await page.locator(".connect-splash").count()).toBe(0);
    expect([...requestedWorkspaceModules]).toEqual([]);
    await page.setViewportSize({ height: 844, width: 390 });
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize(viewport);

    await gateway.resolveDeferred("openclaw.setup.detect", {
      candidates: [
        {
          kind: "claude-cli",
          brandId: "claude",
          label: "Claude Code",
          detail: "Installed, not signed in",
          modelRef: "claude-cli/claude-opus-5",
          recommended: false,
          credentials: false,
        },
      ],
      manualProviders: [{ id: "openai", brandId: "openai", label: "OpenAI" }],
      authOptions: [
        {
          id: "openai-oauth",
          brandId: "openai",
          label: "OpenAI",
          kind: "oauth",
          featured: true,
        },
      ],
      prepareOptions: [
        { id: "ollama", brandId: "ollama", label: "Ollama" },
        { id: "lmstudio", brandId: "lmstudio", label: "LM Studio" },
      ],
      setupComplete: false,
      workspace: "/tmp/openclaw-e2e",
    });
    await loading.waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "Connect a verified AI model" }).waitFor();
    // Restoring desktop starts a grid-row transition after the responsive Lit update.
    await page.locator(".shell:not(.shell--mobile-nav)").waitFor();
    await waitForControlUiProofSurface(page.locator(".shell"), [
      page.getByRole("heading", { name: "Connect a verified AI model" }),
    ]);
    const readySectionTops = await Promise.all(
      sectionTitles.map(
        async (name) => (await page.getByRole("heading", { name }).boundingBox())!.y,
      ),
    );
    expect(
      Math.max(...readySectionTops.map((top, index) => Math.abs(top - loadingSectionTops[index]!))),
    ).toBeLessThanOrEqual(13);
    expect([...requestedWorkspaceModules]).toEqual([]);
    await page.setViewportSize({ height: 844, width: 390 });
    await expectNoHorizontalOverflow(page);
  });

  it.each(["entrance", "ancestor entrance", "lazy content"] as const)(
    "captures recovery pixels after %s readiness despite perpetual descendant animation",
    async (pending) => {
      const page = await createPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      // The endpoint rejects every attempt, including automatic reconnects.
      await installMockGateway(page, {
        methodResponses: {
          connect: {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "origin not allowed",
              details: { code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED },
            },
          },
        },
      });
      await page.goto(suite.server.baseUrl);
      const surface = page.locator(".login-gate__card");
      const recoveryTitle = page.locator(".login-gate__failure-title");
      const recovery = page.getByText("Browser origin not allowed", { exact: true });
      await waitForControlUiProofSurface(surface, [recovery]);

      await page.evaluate((pendingPresentation) => {
        const card = document.querySelector<HTMLElement>(".login-gate__card")!;
        const title = document.querySelector<HTMLElement>(".login-gate__failure-title")!;
        const activity = document.createElement("span");
        activity.dataset.proofActivity = "";
        activity.textContent = "•";
        card.append(activity);
        activity.animate([{ opacity: 0.4 }, { opacity: 1 }], {
          duration: 100,
          iterations: Infinity,
        });
        // Explicit scheduling perturbations widen the unsafe capture window;
        // they do not change the application's wait budgets or capture policy.
        if (pendingPresentation !== "lazy content") {
          card.style.animationName = "none";
          void getComputedStyle(card).animationName;
          card.style.animationDelay = "1s";
          card.style.animationFillMode = "backwards";
          card.style.animationName = "scale-in";
          return;
        }
        const text = title.textContent!;
        const height = title.getBoundingClientRect().height;
        const lazyHost = document.createElement("openclaw-proof-recovery-title");
        lazyHost.style.display = "block";
        lazyHost.style.minHeight = `${height}px`;
        // Keep Lit's marker and text nodes intact for reconnect-driven renders.
        for (const child of title.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            child.textContent = "";
          }
        }
        title.append(lazyHost);
        // A boxed lazy host is not meaningful content. An independent finite
        // descendant completes registration while the activity above stays live.
        const loading = lazyHost.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 1_000 });
        void loading.finished.then(() => {
          customElements.define(
            "openclaw-proof-recovery-title",
            class extends HTMLElement {
              connectedCallback() {
                const label = document.createElement("span");
                label.textContent = text;
                this.replaceChildren(label);
              }
            },
          );
        });
      }, pending);

      const proof = await takeControlUiViewportScreenshot(
        page,
        pending === "ancestor entrance" ? recoveryTitle : surface,
        [recovery],
      );
      // The crop contains recovery words, not the card border or animated dot.
      expect(
        await proofContentPainted(page, proof, recoveryTitle),
        "capture must paint recovery guidance",
      ).toBe(true);
      expect(
        await page
          .locator("[data-proof-activity]")
          .evaluate((element) => element.getAnimations()[0]?.playState),
      ).toBe("running");
      expect(await surface.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(pageErrors).toEqual([]);
    },
  );

  it("keeps finalized recording pixels intact while capturing an element on a tall page", async () => {
    const proofDir = createControlUiE2eArtifactDir("screenshot-video");
    const size = { width: 800, height: 600 };
    const page = await createPage({ viewport: size, recordVideo: { dir: proofDir, size } }, false);
    const context = page.context();
    await page.setContent(`<!doctype html><style>
      body { margin: 0; height: 1800px; }
      #scene { position: fixed; inset: 0; background: conic-gradient(from 90deg,
        #2060e0 0 25%, #e04020 0 50%, #20c060 0 75%, #e0c020 0); }
      #row { position: absolute; left: 48px; top: 80px; width: 302px; height: 29px;
        background: linear-gradient(to right, #a030b0 50%, #20b0c0 50%); }
      #pulse { position: fixed; left: 400px; top: 300px; width: 20px; height: 20px;
        background: white; animation: pulse .1s infinite alternate; }
      @keyframes pulse { to { opacity: .2; } }
      </style><div id="scene"></div><div id="presentation"></div>`);
    await page.locator("#presentation").evaluate((host) => {
      // Capture consumers also select shadow content. Its host's
      // presentation affects the pixels even though parentElement stops at the root.
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<div id="row"><div id="pulse"></div></div>';
      root.prepend(document.querySelector("style")!.cloneNode(true));
      // A delayed entrance can pass Playwright's consecutive-frame geometry check.
      host.animate(
        [
          { transform: "translateY(8px)", opacity: 0.4 },
          { transform: "none", opacity: 1 },
        ],
        {
          delay: 1_000,
          duration: 1_000,
          fill: "both",
        },
      );
    });
    const row = page.locator("#row");
    await row.waitFor();
    const activity = await page.locator("#pulse").evaluateHandle((element) => {
      const animation = element.getAnimations()[0]!;
      const interruptions: string[] = [];
      for (const type of ["cancel", "finish"]) {
        animation.addEventListener(type, () => interruptions.push(type));
      }
      return { animation, interruptions };
    });
    // Give the recorder a readable lead/tail; assertions below inspect every encoded frame.
    await page.waitForTimeout(300);
    const crop = await takeControlUiElementScreenshot(page, row, [row]);
    const presentationState = await page
      .locator("#presentation")
      .evaluate((element) => element.getAnimations()[0]?.playState);
    expect(
      await activity.evaluate(({ animation, interruptions }) => ({
        state: animation.playState,
        interruptions,
      })),
    ).toEqual({ state: "running", interruptions: [] });
    await activity.dispose();
    await takeControlUiViewportScreenshot(page, row, [row]);
    await page.waitForTimeout(300);
    const recording = page.video()!;
    await suite.closeBrowserContext(context);
    const recordingPath = path.join(proofDir, "finalized-recording.webm");
    await recording.saveAs(recordingPath);
    const videoBytes = await readFile(recordingPath);
    // Decode the finalized WebM in a separate, non-recording context. Seeking twice
    // per 25fps recorder frame catches short corruption without depending on host ffmpeg.
    const decoder = await createPageWithoutRecording();
    const frames = await decoder.evaluate(async (webm) => {
      const video = document.createElement("video");
      const loaded = new Promise<void>((resolve, reject) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener(
          "error",
          () => reject(new Error(video.error?.message ?? "video decode failed")),
          { once: true },
        );
      });
      video.src = `data:video/webm;base64,${webm}`;
      await loaded;
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error("invalid finalized video duration");
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const painter = canvas.getContext("2d")!;
      const points = [
        [100, 200, 32, 192, 96],
        [700, 200, 224, 192, 32],
        [100, 500, 224, 64, 32],
        [700, 500, 32, 96, 224],
      ];
      let firstScene = -1;
      const corrupt: number[] = [];
      let samples = 0;
      for (let time = 0.001; time < video.duration; time += 0.02) {
        const sought = new Promise<void>((resolve) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
        });
        video.currentTime = time;
        await sought;
        painter.drawImage(video, 0, 0);
        const good = points.every(([x, y, ...rgb]) => {
          const pixel = painter.getImageData(x!, y!, 1, 1).data;
          return rgb.every((value, channel) => Math.abs(pixel[channel]! - value) < 20);
        });
        if (firstScene < 0 && good) {
          firstScene = time;
        }
        if (firstScene >= 0 && !good) {
          corrupt.push(time);
        }
        samples += 1;
      }
      return { firstScene, corrupt, samples };
    }, videoBytes.toString("base64"));
    expect(
      frames.firstScene,
      "synthetic scene must appear in finalized recording",
    ).toBeGreaterThanOrEqual(0);
    expect(frames.samples).toBeGreaterThan(10);
    expect(
      frames.corrupt,
      "every frame after scene appearance must preserve viewport pixels",
    ).toEqual([]);
    expect(presentationState, "capture waits for the shadow host entrance").toBe("finished");
    const { data, ...info } = decodeProofPng(crop);
    expect([info.width, info.height]).toEqual([302, 29]);
    expect([...data.subarray(0, 3)]).toEqual([160, 48, 176]);
    expect([...data.subarray((info.width - 1) * 4, (info.width - 1) * 4 + 3)]).toEqual([
      32, 176, 192,
    ]);
  });

  it("waits for font pixels and final text bounds before cropping", async () => {
    const page = await createPageWithoutRecording();
    const fontUrl = `${suite.server.baseUrl}fonts/jetbrains-mono-latin.woff2`;
    const font = createDeferredCore();
    await page.route(fontUrl, async (route) => {
      await font.promise;
      await route.fulfill({
        path: path.resolve("ui/public/fonts/jetbrains-mono-latin.woff2"),
        contentType: "font/woff2",
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    });
    await page.setContent(
      `<style>@font-face { font-family: proof; src: url("${fontUrl}"); }
      body { margin: 0; } #text { display: inline-block; margin: 40px;
        font: 40px proof, serif; background: #a030b0; color: white; }</style>
      <div id="text">iiiiiiiiiiii</div>`,
      { waitUntil: "domcontentloaded" },
    );
    const text = page.locator("#text");
    await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loading");
    // A delayed font changes both glyph pixels and the inline element's width.
    // Release independently of capture so a missing font wait produces a bad PNG.
    const release = setTimeout(() => font.resolve(), 1_000);
    let png: Buffer;
    try {
      png = await takeControlUiElementScreenshot(page, text, [text]);
    } finally {
      clearTimeout(release);
      font.resolve();
    }
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check("40px proof"))).toBe(true);
    const bounds = (await text.boundingBox())!;
    const decoded = decodeProofPng(png);
    expect(decoded.width).toBe(Math.ceil(bounds.x + bounds.width) - Math.floor(bounds.x));
    expect(decoded.height).toBe(Math.ceil(bounds.y + bounds.height) - Math.floor(bounds.y));
    expect(decoded.data.some((value, index) => index % 4 === 0 && value > 230)).toBe(true);
  });

  it("crops fractional bounds at high device scale and rejects elements outside the viewport", async () => {
    const page = await createPage(
      { viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 },
      false,
    );
    await page.clock.install();
    await page.setContent(`<!doctype html><style>body { margin: 0; height: 1800px; }
      #row { position: absolute; left: 48.25px; top: 940.25px; width: 302.5px; height: 29.5px; background: #a030b0; }
      #wide { width: 801px; height: 20px; } #tall { width: 20px; height: 601px; }
      </style><div id="row"></div><div id="wide"></div><div id="tall"></div>`);
    const row = page.locator("#row");
    const crop = await takeControlUiElementScreenshot(page, row, [row]);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    const viewportImage = decodeProofPng(await takeControlUiViewportScreenshot(page, row, [row]));
    for (const selector of ["#wide", "#tall"]) {
      const surface = page.locator(selector);
      await expect(takeControlUiElementScreenshot(page, surface, [surface])).rejects.toThrow(
        "not contained by the viewport",
      );
    }
    const { data, ...info } = decodeProofPng(crop);
    // Unclipped CDP uses the actual backing surface, not necessarily emulated DPR.
    expect([
      (info.width * 800) / viewportImage.width,
      (info.height * 600) / viewportImage.height,
    ]).toEqual([303, 30]);
    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect([...data.subarray(center, center + 3)]).toEqual([160, 48, 176]);

    await page.setContent('<body style="margin:0;width:1600px;height:1200px"></body>');
    await expect(
      takeControlUiScreenshotFrame(page, page.locator("body"), [], { fullPage: true }),
    ).rejects.toThrow("Full-page proof must fit the viewport-frame dimensions");

    await page.setContent(`<style>body { margin: 0; min-height: 100vh; } .stamp { position: absolute; background: var(--stamp); }
      #first { top: 90.25px; width: 302.5px; height: 29.5px; animation: enter .1s 60s both; }
      @keyframes enter { from { left: 68.25px; height: 0; } to { left: 88.25px; height: 29.5px; } }
      #second { left: 411.5px; top: 311.25px; width: 126.25px; height: 61.5px; animation: pulse 1s infinite; }
      @keyframes pulse { to { opacity: .2; } }
      </style><div id="first" class="stamp"></div><div id="second" class="stamp"></div>`);
    await page.evaluate(() => {
      let stamp = 0;
      const paint = () => {
        stamp += 1;
        document.documentElement.style.setProperty(
          "--stamp",
          `rgb(${stamp & 255}, ${(stamp >>> 8) & 255}, 128)`,
        );
        requestAnimationFrame(paint);
      };
      paint();
    });
    const regions = [page.locator("#first"), page.locator("#second")];
    const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), regions, {
      elements: regions,
      animations: "disabled",
    });
    expect(await regions[1]!.evaluate((element) => element.getAnimations()[0]?.playState)).toBe(
      "running",
    );
    const whole = decodeProofPng(frame.png);
    const scale = whole.width / 800;
    // Static preparation finishes the delayed entrance before measuring bounds.
    // Pixels still change each rAF; both crops must come from the retained frame.
    for (const [index, [x, y, width, height]] of [
      [88.25, 90.25, 302.5, 29.5],
      [411.5, 311.25, 126.25, 61.5],
    ].entries()) {
      const left = Math.floor(x! * scale);
      const top = Math.floor(y! * scale);
      const right = Math.ceil((x! + width!) * scale);
      const bottom = Math.ceil((y! + height!) * scale);
      const region = decodeProofPng(frame.elements[index]!.png);
      expect([region.width, region.height]).toEqual([right - left, bottom - top]);
      const rows = [];
      for (let pixelRow = top; pixelRow < bottom; pixelRow += 1) {
        rows.push(
          whole.data.subarray(
            (pixelRow * whole.width + left) * 4,
            (pixelRow * whole.width + right) * 4,
          ),
        );
      }
      expect(
        Buffer.from(region.data).equals(Buffer.concat(rows)),
        `region ${index} uses the same frame`,
      ).toBe(true);
    }

    await regions[1]!.evaluate((element) => element.setAttribute("style", "visibility: hidden"));
    // This target stays hidden; only the rejection needs a short readiness window.
    vi.setConfig({ expect: { poll: { interval: 100, timeout: 1_000 } } });
    try {
      await expect(
        takeControlUiScreenshotFrame(page, page.locator("body"), [regions[0]!], {
          elements: [regions[1]!],
          animations: "disabled",
        }),
      ).rejects.toThrow("Proof frame did not reach visible, settled targets");
    } finally {
      vi.resetConfig();
    }

    await pauseVirtualClock(page);
    const captureTime = await page.evaluate(() => Date.now());
    await page.setContent(`<style>html, body { margin: 0; height: 100%; overflow: hidden; }
      #scroller { position: absolute; top: 40px; left: 10px; width: 300px; height: 200px; overflow: auto; }
      #spacer { position: relative; height: 1000px; }
      #target { position: absolute; top: 500px; width: 100px; height: 40px; background: #123456; }
      </style><div id="scroller" data-resets="0"><div id="spacer"><div id="target">Saved</div></div></div>`);
    await page.locator("#scroller").evaluate((element) => {
      let resets = 0;
      element.addEventListener("scroll", () => {
        // Deferred renders can undo centering while leaving the target visible.
        if (element.scrollTop === 420 && resets < 2) {
          resets += 1;
          element.setAttribute("data-resets", String(resets));
          element.scrollTop = 350;
        }
      });
    });
    const target = page.locator("#target");
    await target.evaluate((element) => {
      setTimeout(() => {
        element.textContent = "";
      }, 2_000);
    });
    const scrolled = await takeControlUiScreenshotFrame(page, page.locator("body"), [target], {
      elements: [target],
      scrollTo: target,
      animations: "disabled",
    });
    expect(await page.locator("#scroller").getAttribute("data-resets")).toBe("2");
    expect((await target.boundingBox())?.y).toBe(120);
    expect(scrolled.elements[0]!.bounds.y).toBe(120);
    expect(await target.textContent()).toBe("Saved");
    expect(await page.evaluate(() => Date.now())).toBe(captureTime);
    await page.clock.runFor(2_000);
    expect(await target.textContent()).toBe("");
  });

  defineControlUiFrameIdentityTests(createPageWithoutRecording);

  it("falls back to the login gate when stored credentials are rejected", async () => {
    const page = await createPage();
    const gateway = await connect(page, "#token=stale-token");
    await page.locator(".connect-splash").waitFor();

    await gateway.rejectDeferred("connect", {
      code: "UNAUTHORIZED",
      message: "unauthorized: gateway token mismatch",
      details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
    });
    await page.locator("openclaw-login-gate").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
  });

  it("keeps retryable Gateway startup on the progress splash", async () => {
    const page = await createPage();
    const loginGateMounted = await traceLoginGateMounts(page);
    const gateway = await connect(page, "#token=e2e-shared-token");
    const initialConnectCount = (await gateway.getRequests("connect")).length;
    await gateway.deferNext("connect");
    await gateway.rejectDeferred("connect", {
      code: "UNAVAILABLE",
      message: "gateway starting; retry shortly",
      details: { reason: "startup-sidecars" },
      retryable: true,
    });

    const splash = page.locator(".connect-splash");
    await splash.getByText("Gateway starting…", { exact: true }).waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
    await expect
      .poll(async () => await splash.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");

    await expect
      .poll(async () => (await gateway.getRequests("connect")).length)
      .toBeGreaterThan(initialConnectCount);
    await resolveConnect(page, gateway);
  });

  it("uses the splash for a stored device token on reload", async () => {
    const page = await createPage();
    const loginGateMounted = await traceLoginGateMounts(page);
    const gateway = await connect(page);
    await page.locator(".connect-splash").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
    await resolveConnect(page, gateway);
    expect(await page.locator(".connect-splash").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);

    // The hello stored a device token, so the reload connect is authenticated
    // and must paint the splash instead of flashing the gate.
    await page.reload({ waitUntil: "domcontentloaded" });
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);

    await resolveConnect(page, gateway);
  });
});
