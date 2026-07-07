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
    category?: string;
    pinned?: boolean;
    pinnedAt?: number;
    hasActiveRun?: boolean;
    status?: string;
    spawnedBy?: string;
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

function sessionsListResponse(
  sessions: unknown[],
  options: {
    hasMore?: boolean;
    nextOffset?: number | null;
    offset?: number;
    totalCount?: number;
  } = {},
) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    hasMore: options.hasMore ?? false,
    limitApplied: 50,
    nextOffset: options.nextOffset ?? null,
    offset: options.offset ?? 0,
    path: "",
    sessions,
    totalCount: options.totalCount ?? sessions.length,
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

function actionPointerEvents(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).pointerEvents);
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
        "sessions.list": {
          cases: [
            ...[50, 100, 150].map((offset) => ({
              match: { offset, search: "helpers" },
              response: sessionsListResponse(
                Array.from({ length: 50 }, (_, index) =>
                  sessionRow(
                    `agent:main:hidden-helper-${offset + index}`,
                    `Hidden helper ${offset + index}`,
                    baseTime - offset - index,
                    { spawnedBy: "agent:main:main" },
                  ),
                ),
                { hasMore: true, nextOffset: offset + 50, offset, totalCount: 250 },
              ),
            })),
            {
              match: { search: "helpers" },
              response: sessionsListResponse(
                Array.from({ length: 50 }, (_, index) =>
                  sessionRow(
                    `agent:main:hidden-helper-${index}`,
                    `Hidden helper ${index}`,
                    baseTime - index,
                    { spawnedBy: "agent:main:main" },
                  ),
                ),
                { hasMore: true, nextOffset: 50, totalCount: 250 },
              ),
            },
            {
              match: { offset: 50, search: "release" },
              response: sessionsListResponse(
                [sessionRow("agent:main:release", "Release planning", baseTime - 60_000)],
                { offset: 50, totalCount: 51 },
              ),
            },
            {
              match: { search: "release" },
              response: sessionsListResponse(
                Array.from({ length: 50 }, (_, index) =>
                  sessionRow(
                    `agent:main:release-helper-${index}`,
                    `Release helper ${index}`,
                    baseTime - index,
                    { spawnedBy: "agent:main:main" },
                  ),
                ),
                { hasMore: true, nextOffset: 50, totalCount: 51 },
              ),
            },
            {
              match: {},
              response: sessionsListResponse([
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
              ]),
            },
          ],
        },
        "sessions.patch": {},
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      // Sidebar: pinned rows form their own group ahead of the Sessions group.
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

      // The current-main full context menu remains intact: active rows cannot
      // archive, while an idle row can.
      await sidebarMigration.hover();
      await sidebarMigration.getByRole("button", { name: "Open session menu" }).click();
      await expect
        .poll(() => page.getByRole("menuitem", { name: "Archive session" }).isDisabled())
        .toBe(true);
      await page.keyboard.press("Escape");
      await sidebarResearch.hover();
      await sidebarResearch.getByRole("button", { name: "Open session menu" }).click();
      await page.getByRole("menuitem", { name: "Archive session" }).click();
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
      // Automatic search is intentionally bounded: an all-hidden result set
      // must not scan the entire session store from one palette query.
      await paletteInput.fill("helpers");
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.list");
          return requests.filter((request) => requireRecord(request.params).search === "helpers")
            .length;
        })
        .toBe(4);
      await page.waitForTimeout(400);
      const boundedSearchRequests = await gateway.getRequests("sessions.list");
      expect(
        boundedSearchRequests.filter(
          (request) => requireRecord(request.params).search === "helpers",
        ),
      ).toHaveLength(4);

      await paletteInput.fill("release");
      const paletteOption = page
        .locator(".cmd-palette__item")
        .filter({ hasText: "Release planning" });
      await paletteOption.waitFor({ state: "visible", timeout: 10_000 });
      // The first result page contains 50 hidden child sessions; search must
      // follow nextOffset before exposing the visible chat on page two.
      await expect
        .poll(() =>
          page.locator(".cmd-palette__item").filter({ hasText: "Release helper" }).count(),
        )
        .toBe(0);
      const searchRequests = await gateway.getRequests("sessions.list");
      expect(
        searchRequests.some((request) => {
          const params = requireRecord(request.params);
          return params.search === "release" && params.offset === 50;
        }),
      ).toBe(true);
      await captureUiProof(page, "command-palette-session-search.png");
      await paletteOption.click();
      await expect.poll(() => page.url()).toContain("session=agent%3Amain%3Arelease");
    } finally {
      await context.close();
    }
  });
  it("renames, deletes, and toggles sidebar session groups", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { archived: true },
              response: sessionsListResponse([
                sessionRow("agent:main:old-notes", "Old notes", baseTime - 300_000, {
                  archived: true,
                  category: "Research",
                }),
              ]),
            },
            {
              match: {},
              response: sessionsListResponse([
                sessionRow("agent:main:main", "Main", baseTime),
                sessionRow("agent:main:paper-a", "Paper A", baseTime - 60_000, {
                  category: "Research",
                }),
                sessionRow("agent:main:paper-b", "Paper B", baseTime - 90_000, {
                  category: "Research",
                }),
              ]),
            },
          ],
        },
        "sessions.patch": {},
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      // Categorized rows render as their own sidebar group section.
      const groups = page.locator(".sidebar-recent-sessions__group");
      const researchGroup = groups.filter({ hasText: "Research" });
      await researchGroup.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => researchGroup.locator(".sidebar-recent-session").count()).toBe(2);
      await captureUiProof(page, "sidebar-session-groups.png");

      // Rename group: every member session is patched, including the archived
      // row that only the unbounded archived list window can see.
      const groupMenuButton = researchGroup.getByRole("button", {
        name: "Group options for Research",
      });
      await researchGroup.locator(".sidebar-recent-sessions__head").hover();
      await groupMenuButton.click();
      await page.getByRole("menuitem", { name: "Rename group…" }).waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-group-menu.png");
      page.once("dialog", (dialog) => void dialog.accept("Projects"));
      await page.getByRole("menuitem", { name: "Rename group…" }).click();
      for (const key of ["agent:main:paper-a", "agent:main:paper-b", "agent:main:old-notes"]) {
        const patch = await waitForPatch(
          gateway,
          (params) => params.key === key && params.category === "Projects",
        );
        expect(requireRecord(patch.params)).toMatchObject({ category: "Projects", key });
      }

      // Delete group: sessions survive and move back to Ungrouped.
      await researchGroup.locator(".sidebar-recent-sessions__head").hover();
      page.once("dialog", (dialog) => void dialog.accept());
      await groupMenuButton.click();
      await page.getByRole("menuitem", { name: "Delete group…" }).click();
      const dissolvePatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:paper-a" && params.category === null,
      );
      expect(requireRecord(dissolvePatch.params)).toMatchObject({
        category: null,
        key: "agent:main:paper-a",
      });

      // Group by "None" flattens the category sections into the plain list.
      await page.getByRole("button", { name: "Sort sessions" }).click();
      await page.getByRole("menuitemradio", { name: "None" }).waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-groupby-sort-menu.png");
      await page.getByRole("menuitemradio", { name: "None" }).click();
      await expect.poll(() => groups.count()).toBe(1);
      await expect.poll(() => groups.first().locator(".sidebar-recent-session").count()).toBe(3);
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
      const chatsGroup = sessionGroups.filter({ hasText: "Sessions" });
      await expect
        .poll(() => trimmedTextContents(pinnedGroup.locator(".sidebar-recent-session__name")))
        .toEqual(["Pinned only"]);
      await expect.poll(() => chatsGroup.locator(".sidebar-recent-session").count()).toBe(0);
      await expect.poll(() => page.locator(".sidebar-recent-session--active").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("keeps sidebar session controls reachable on touch pointers", async () => {
    const context = await browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            "agent:main:research",
            "Research notes",
            Date.parse("2026-07-01T15:00:00.000Z"),
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const row = page
        .locator(".sidebar-recent-sessions__list .sidebar-recent-session")
        .filter({ hasText: "Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionPointerEvents(pin)).toBe("auto");
      await expect.poll(() => actionOpacity(menu)).toBe("1");
      await expect.poll(() => actionPointerEvents(menu)).toBe("auto");
      await menu.click();
      await page.getByRole("menuitem", { name: "Archive session" }).waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });
});
