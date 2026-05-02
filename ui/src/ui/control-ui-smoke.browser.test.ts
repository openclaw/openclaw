import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-contract.js";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function settleApp(app: ReturnType<typeof mountApp>) {
  for (let i = 0; i < 12; i++) {
    await app.updateComplete;
    await nextFrame();
  }
  await app.updateComplete;
}

function textContent(root: ParentNode) {
  return root.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function expectNoObviousA11yRegressions(root: ParentNode) {
  const unnamedButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) =>
      !button.textContent?.trim() &&
      !button.getAttribute("aria-label")?.trim() &&
      !button.getAttribute("title")?.trim(),
  );
  expect(unnamedButtons, "all icon-only buttons should have an accessible name").toHaveLength(0);

  const ids = Array.from(root.querySelectorAll<HTMLElement>("[id]")).map((element) => element.id);
  const duplicateIds = ids.filter((id, index) => id && ids.indexOf(id) !== index);
  expect(duplicateIds, "rendered smoke view should not duplicate element ids").toEqual([]);
}

describe("Control UI smoke (browser)", () => {
  it("boots with authenticated bootstrap config and strips fragment tokens", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith(CONTROL_UI_BOOTSTRAP_CONFIG_PATH)) {
        return new Response(
          JSON.stringify({
            basePath: "",
            assistantName: "Smoke Assistant",
            assistantAvatar: "/avatar/main",
            assistantAgentId: "main",
            serverVersion: "2026.4.27-smoke",
            buildProvenance: {
              sourceRepositoryUrl: "https://github.com/openclaw/openclaw",
              commitSha: "abc123",
              buildTimestamp: "2026-04-30T00:00:00.000Z",
              packageVersion: "2026.4.27",
              lockfileSha256: "0".repeat(64),
              ciRunId: "smoke",
            },
            localMediaPreviewRoots: [],
            embedSandbox: "scripts",
            allowExternalEmbedUrls: false,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = mountApp("/ui/debug#token=smoke-token");
    await settleApp(app);

    expect(app.settings.token).toBe("smoke-token");
    expect(app.assistantName).toBe("Smoke Assistant");
    expect(app.serverVersion).toBe("2026.4.27-smoke");
    expect(app.buildProvenance?.commitSha).toBe("abc123");
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(fetchMock).toHaveBeenCalledWith(
      `/ui${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer smoke-token",
        }),
      }),
    );
    expectNoObviousA11yRegressions(app);
  });

  it("renders channel health and Slack readback warnings", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const app = mountApp("/channels");
    app.connected = true;
    app.channelsLoading = false;
    app.channelsSnapshot = {
      ts: now,
      channelOrder: ["slack"],
      channelLabels: { slack: "Slack" },
      channelAccounts: {
        slack: [
          {
            accountId: "main",
            name: "Workspace",
            enabled: true,
            configured: true,
            running: true,
            connected: true,
            healthState: "healthy",
            lastConnectedAt: now - 60_000,
            lastTransportActivityAt: now - 15 * 60_000,
            readbackState: "missing_scopes",
            readbackRequiredScopes: [
              "channels:history",
              "groups:history",
              "im:history",
              "mpim:history",
            ],
            readbackMissingScopes: ["groups:history", "mpim:history"],
            lastReadbackAt: now - 30_000,
            lastReadbackError: "Missing Slack history scopes: groups:history, mpim:history",
          },
        ],
      },
      channelDefaultAccountId: { slack: "main" },
      channels: {
        slack: {
          configured: true,
          running: true,
          connected: true,
          healthState: "healthy",
          readbackState: "missing_scopes",
          readbackMissingScopes: ["groups:history", "mpim:history"],
          lastReadbackError: "Missing Slack history scopes: groups:history, mpim:history",
        },
      },
    };
    app.requestUpdate();
    await settleApp(app);

    await vi.waitFor(() => {
      const text = textContent(app);
      expect(text).toContain("Configured");
      expect(text).toContain("Running");
      expect(text).toContain("Connected");
      expect(text).toContain("Slack transport activity is stale");
      expect(text).toContain("Slack message readback is missing_scopes");
      expect(text).toContain("Slack (Workspace) readback is missing_scopes");
    });
    expectNoObviousA11yRegressions(app);
  });
});
