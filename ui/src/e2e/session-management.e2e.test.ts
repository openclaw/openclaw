// Control UI tests cover session management through the sidebar and the command palette.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: {
    archived?: boolean;
    pinned?: boolean;
    pinnedAt?: number;
    hasActiveRun?: boolean;
    status?: string;
  } = {},
) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
    ...options,
  };
}

function sessionsListResponse(sessions: unknown[]) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    hasMore: false,
    limitApplied: 50,
    nextOffset: null,
    offset: 0,
    path: "",
    sessions,
    totalCount: sessions.length,
    ts: Date.now(),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

async function waitForPatch(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("sessions.patch");
    const match = requests.find((request) => predicate(requireRecord(request.params)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`No matching sessions.patch request found: ${JSON.stringify(requests)}`);
}


function trimmedTextContents(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => element.textContent?.trim() ?? ""),
  );
}

function actionOpacity(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).opacity);
}

async function captureUiProof(page: Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "thread-management");
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

describeControlUiE2e("Control UI session management mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("manages sessions through the sidebar groups and command palette", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", baseTime),
          sessionRow("agent:main:release", "Release planning", baseTime - 60_000, {
            pinned: true,
            pinnedAt: baseTime - 30_000,
          }),
          sessionRow("agent:main:migration", "Data migration", baseTime - 90_000, {
            hasActiveRun: true,
            status: "running",
          }),
          sessionRow("agent:main:research", "Research notes", baseTime - 120_000),
          // Hidden row classes: the static mock returns them for every
          // sessions.list call, so the palette must filter them client-side.
          sessionRow("subagent:release-helper", "Release subagent", baseTime - 200_000),
          sessionRow("agent:main:old-release", "Release archive", baseTime - 300_000, {
            archived: true,
          }),
        ]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      // Sidebar: pinned rows form their own group ahead of the Chats group.
      const sidebarRows = page.locator(".sidebar-recent-sessions__list .sidebar-recent-session");
      await sidebarRows.first().waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebarRows.first().textContent()).toContain("Release planning");
      const groups = page.locator(".sidebar-recent-sessions__group");
      await expect.poll(() => groups.count()).toBe(2);
      await expect
        .poll(() => groups.first().locator(".sidebar-recent-sessions__label-text").textContent())
        .toContain("Pinned");

      // Chats keep recency order with the open session highlighted in place —
      // selecting a row must not reshuffle the list.
      const chatRows = groups.nth(1).locator(".sidebar-recent-session");
      const rowNames = () =>
        chatRows.evaluateAll((rows) =>
          rows.map((row) => row.querySelector(".sidebar-recent-session__name")?.textContent ?? ""),
        );
      await expect.poll(rowNames).toEqual(["Main", "Data migration", "Research notes"]);
      const sidebarMigration = sidebarRows.filter({ hasText: "Data migration" });
      await expect
        .poll(() => sidebarMigration.locator(".session-run-spinner").isVisible())
        .toBe(true);

      // Hover-revealed management actions on sidebar rows.
      const sidebarResearch = sidebarRows.filter({ hasText: "Research notes" });
      const sidebarResearchPin = sidebarResearch.getByRole("button", { name: "Pin session" });
      await page.mouse.move(900, 500);
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("0");
      const sidebarReleasePin = sidebarRows
        .filter({ hasText: "Release planning" })
        .getByRole("button", { name: "Unpin session" });
      // Pinned badge stays visible without hover.
      await expect.poll(() => actionOpacity(sidebarReleasePin)).toBe("1");
      await sidebarResearch.hover();
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("1");
      await captureUiProof(page, "sidebar-sessions.png");

      await sidebarReleasePin.click();
      const pinPatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:release" && params.pinned === false,
      );
      expect(requireRecord(pinPatch.params)).toMatchObject({
        key: "agent:main:release",
        pinned: false,
      });

      // Archive stays disabled for rows with an active run; the idle row archives.
      const sidebarMigrationArchive = sidebarMigration.getByRole("button", {
        name: "Archive session",
      });
      await expect.poll(() => sidebarMigrationArchive.isDisabled()).toBe(true);
      const sidebarResearchArchive = sidebarResearch.getByRole("button", {
        name: "Archive session",
      });
      await sidebarResearch.hover();
      await sidebarResearchArchive.click();
      const archivePatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:research" && params.archived === true,
      );
      expect(requireRecord(archivePatch.params)).toMatchObject({
        archived: true,
        key: "agent:main:research",
      });

      // Selecting a visible row must not reshuffle the list: the highlight
      // moves while every row keeps its slot. (The mocked gateway keeps
      // returning the same list, so the archived row stays visible here.)
      const researchLink = sidebarResearch.locator("a").first();
      await researchLink.click();
      await expect.poll(() => page.url()).toContain("session=agent%3Amain%3Aresearch");
      await expect.poll(rowNames).toEqual(["Main", "Data migration", "Research notes"]);
      await expect
        .poll(() =>
          chatRows
            .filter({ hasText: "Research notes" })
            .first()
            .evaluate((row) => row.classList.contains("sidebar-recent-session--active")),
        )
        .toBe(true);

      // Command palette is the single search surface: querying lists matching
      // chats from the gateway and selecting one navigates to it.
      await page.getByRole("button", { name: "Open command palette" }).click();
      const paletteInput = page.locator(".cmd-palette__input");
      await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
      await paletteInput.fill("release");
      const paletteOption = page
        .locator(".cmd-palette__item")
        .filter({ hasText: "Release planning" });
      await paletteOption.waitFor({ state: "visible", timeout: 10_000 });
      // Subagent and archived rows never surface as palette chats.
      await expect
        .poll(() => page.locator(".cmd-palette__item").filter({ hasText: "Release subagent" }).count())
        .toBe(0);
      await expect
        .poll(() => page.locator(".cmd-palette__item").filter({ hasText: "Release archive" }).count())
        .toBe(0);
      const searchRequests = await gateway.getRequests("sessions.list");
      expect(
        searchRequests.some((request) => requireRecord(request.params).search === "release"),
      ).toBe(true);
      await captureUiProof(page, "command-palette-session-search.png");
      await paletteOption.click();
      await expect.poll(() => page.url()).toContain("session=agent%3Amain%3Arelease");
    } finally {
      await context.close();
    }
  });
  it("does not duplicate the active chat when its only session is pinned", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:pinned", "Pinned only", Date.parse("2026-07-01T16:00:00.000Z"), {
            pinned: true,
          }),
        ]),
      },
      sessionKey: "agent:main:pinned",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const sessionGroups = page.locator(".sidebar-recent-sessions__group");
      const pinnedGroup = sessionGroups.filter({ hasText: "Pinned" });
      const chatsGroup = sessionGroups.filter({ hasText: "Chats" });
      await expect
        .poll(() => trimmedTextContents(pinnedGroup.locator(".sidebar-recent-session__name")))
        .toEqual(["Pinned only"]);
      await expect.poll(() => chatsGroup.locator(".sidebar-recent-session").count()).toBe(0);
      await expect.poll(() => page.locator(".sidebar-recent-session--active").count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
