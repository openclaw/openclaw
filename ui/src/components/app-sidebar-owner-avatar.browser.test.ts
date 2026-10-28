import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  readAvatarGatewayContext,
  setAvatarGatewayOrigin,
} from "../lib/identity-avatar-context.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import "../test-helpers/load-styles.ts";
import "./app-sidebar.tsx";

setupSidebarTest();

async function mountOwners() {
  const { page } = await import("vitest/browser");
  await page.viewport(1280, 720);
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  gateway.publish({ selfUser: { id: "profile-frank", name: "Frank" } });
  const sessions = createSessionsHarness("main", ["agent:main:frank", "agent:main:bob"]);
  const result = sessions.sessions.state.result!;
  result.owners = [
    { type: "human", id: "profile-frank", label: "Frank" },
    { type: "human", id: "profile-bob", label: "Bob" },
  ];
  result.sessions.forEach((row, index) => {
    row.owner = { actor: result.owners![index]! };
  });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.setSessionOwnerFilter("profile-frank");
  await sidebar.updateComplete;
  const trigger = sidebar.querySelector<HTMLElement>("#sidebar-session-owner-title")!;
  const avatar = () => trigger.querySelector<HTMLElement>(".viewer-avatar");
  await expect.poll(() => avatar()?.textContent).toBe("F");
  expect(trigger.textContent).toContain("My sessions");
  return { page, gateway, sessions, result, sidebar, trigger, avatar };
}

describe.runIf("__vitest_browser__" in globalThis)("sidebar owner avatar", () => {
  it("keeps trigger and menu avatars mounted across session and Gateway updates", async () => {
    const { page, gateway, sessions, result, sidebar, trigger, avatar } = await mountOwners();
    const original = avatar();
    expect(original).not.toBeNull();
    await page.elementLocator(trigger).click();
    const menuAvatar = () =>
      sidebar.querySelector(
        '.picker-select__option[data-value="owner:profile-frank"] .viewer-avatar',
      );
    await expect.poll(menuAvatar).not.toBeNull();
    const originalMenuAvatar = menuAvatar();

    for (let revision = 1; revision <= 3; revision++) {
      const nextResult = structuredClone(result);
      nextResult.ts += revision;
      nextResult.sessions.forEach((row) => {
        row.updatedAt = revision;
      });
      sessions.publish({ result: nextResult });
      await sidebar.sessionData.refreshSidebarSessions();
      await sidebar.updateComplete;
      expect(sidebar.sessionData.sessionsResult?.ts).toBe(result.ts + revision);
      expect(avatar(), "session refresh must not remount the owner avatar").toBe(original);
      gateway.publish({ presence: { ts: revision, clients: [] } });
      await sidebar.updateComplete;
      expect(avatar(), "unrelated Gateway publication must not remount the owner avatar").toBe(
        original,
      );
      expect(menuAvatar(), "the open owner menu must retain its avatar too").toBe(
        originalMenuAvatar,
      );
      expect(original!.isConnected).toBe(true);
    }
  });

  it("refreshes changed portrait URLs and participant identities without stale owner facts", async () => {
    const previous = readAvatarGatewayContext();
    onTestFinished(() =>
      setAvatarGatewayOrigin(
        previous.origin,
        previous.authTokens,
        previous.resourceBasePath,
        previous.storageScope,
      ),
    );
    setAvatarGatewayOrigin(location.origin);
    const firstUrl = new URL("/api/users/profile-bob/avatar?v=1", location.origin).href;
    const secondUrl = new URL("/api/users/profile-bob/avatar?v=2", location.origin).href;
    const images = new Map([
      [firstUrl, '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'],
      [secondUrl, '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>'],
    ]);
    const requestUrl = (request: RequestInfo | URL) =>
      request instanceof Request ? request.url : String(request);
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url = requestUrl(request);
      const image = images.get(url);
      if (!image) {
        throw new Error(`Unexpected avatar request: ${url}`);
      }
      return new Response(image, { headers: { "content-type": "image/svg+xml" } });
    });
    const { sessions, result, sidebar, avatar } = await mountOwners();
    sidebar.setSessionOwnerFilter("profile-bob");
    await sidebar.updateComplete;
    const portrait = structuredClone(result);
    portrait.owners![1]!.identity = { type: "profile", id: "profile-bob" };
    const image = () => avatar()?.querySelector("img");
    for (const [url, width] of [
      [firstUrl, 2],
      [secondUrl, 3],
    ] as const) {
      portrait.owners![1]!.avatarUrl = url;
      sessions.publish({ result: structuredClone(portrait) });
      await sidebar.sessionData.refreshSidebarSessions();
      await sidebar.updateComplete;
      await expect.poll(() => image()?.naturalWidth).toBe(width);
      expect(avatar()?.dataset.avatarState).toBe("loaded");
    }
    expect(fetchAvatar.mock.calls.map(([request]) => requestUrl(request))).toEqual([
      firstUrl,
      secondUrl,
    ]);

    portrait.owners![1]!.identity = {
      type: "observation",
      pluginId: "fixture",
      accountId: null,
      senderKind: "human",
      id: "profile-bob",
    };
    sessions.publish({ result: structuredClone(portrait) });
    await sidebar.sessionData.refreshSidebarSessions();
    await sidebar.updateComplete;
    await expect.poll(() => image()).toBeNull();
    expect(avatar()?.dataset.avatarState).toBe("none");
    expect(avatar()?.textContent).toBe("B");
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
  });

  it("updates changed owner facts and removes avatars for non-owner filters", async () => {
    const { page, gateway, sessions, result, sidebar, trigger, avatar } = await mountOwners();
    gateway.gateway.updateSelfUser({ name: "Fiona Example" });
    await sidebar.updateComplete;
    await expect.poll(() => avatar()?.textContent).toBe("FE");
    expect(avatar()?.getAttribute("aria-label")).toBe("Fiona Example");

    sidebar.setSessionOwnerFilter("profile-bob");
    await sidebar.updateComplete;
    await expect.poll(() => avatar()?.textContent).toBe("B");
    expect(trigger.textContent).toContain("Bob");
    const renamed = structuredClone(result);
    renamed.owners![1]!.label = "Beatrice Jones";
    sessions.publish({ result: renamed });
    await sidebar.sessionData.refreshSidebarSessions();
    await sidebar.updateComplete;
    await expect.poll(() => avatar()?.textContent).toBe("BJ");
    expect(trigger.textContent).toContain("Beatrice Jones");

    await page.elementLocator(trigger).click();
    await page.getByRole("option", { name: "All owners", exact: true }).click();
    await expect.poll(() => trigger.textContent).toContain("All owners");
    expect(trigger.querySelector(".picker-select__leading")).toBeNull();
    await page.elementLocator(trigger).click();
    await page.getByRole("option", { name: "Involving me", exact: true }).click();
    await expect.poll(() => trigger.textContent).toContain("Involving me");
    expect(avatar()).toBeNull();
    expect(trigger.querySelector(".picker-select__leading")).toBeNull();
  });
});
