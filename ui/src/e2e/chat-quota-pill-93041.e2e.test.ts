// Regression #93041: provider usage stays in the desktop composer's context popover.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiE2eWaitTimeoutMs,
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI #93041 desktop chat quota popover (mocked Gateway E2E)",
});

const baseTime = 1_700_000_000_000;
let artifactDir: string;
const captureOwnershipProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const ownershipProofPhase = process.env.OPENCLAW_UI_PROOF_PHASE?.trim() || "candidate";
let ownershipProofDir: string;

function providerStatus<Usage>(
  provider: string,
  displayName: string,
  usage: Usage,
  type = "oauth",
) {
  return {
    provider,
    displayName,
    status: "ok",
    profiles: [{ profileId: provider, type, status: "ok" }],
    usage,
  };
}

const authStatusWithUsage = {
  ts: baseTime,
  providers: [
    providerStatus("openai", "OpenAI", {
      providerId: "openai",
      windows: [{ label: "Week", usedPercent: 71, resetAt: Date.now() + 4 * 86_400_000 }],
    }),
    providerStatus(
      "github-copilot",
      "Copilot",
      {
        providerId: "github-copilot",
        windows: [{ label: "Day", usedPercent: 41 }],
      },
      "token",
    ),
  ],
};

const gatewayInjectedSessions = {
  count: 1,
  defaults: { contextTokens: 200_000, model: "gateway-injected", modelProvider: "openai" },
  path: "",
  sessions: [
    {
      contextTokens: 200_000,
      key: "main",
      kind: "direct",
      model: "gateway-injected",
      modelProvider: "openai",
      totalTokens: 46_000,
      totalTokensFresh: true,
      updatedAt: Date.now(),
    },
  ],
  ts: Date.now(),
};

const highPressureSessions = {
  ...gatewayInjectedSessions,
  sessions: [{ ...gatewayInjectedSessions.sessions[0], totalTokens: 190_000 }],
};

const agentsList = {
  agents: [
    { id: "main", name: "Main" },
    { id: "work", name: "Work" },
  ],
  defaultId: "main",
  mainKey: "main",
  scope: "global",
};

function agentAuthStatus(agentId: "main" | "work") {
  const isMain = agentId === "main";
  return {
    ts: baseTime + (isMain ? 1 : 2),
    providers: [
      providerStatus("openai", isMain ? "Main OpenAI" : "Work OpenAI", {
        providerId: "openai",
        plan: isMain ? "Main Pro" : "Work Team",
        accountEmail: `${agentId}@example.test`,
        windows: [
          {
            label: "Week",
            usedPercent: isMain ? 81 : 24,
            resetAt: Date.now() + 4 * 86_400_000,
          },
        ],
      }),
    ],
  };
}

const selectedGlobalSessions = {
  ...gatewayInjectedSessions,
  sessions: [
    {
      ...gatewayInjectedSessions.sessions[0],
      key: "global",
      kind: "global",
    },
  ],
};

const workGlobalSession = {
  ...selectedGlobalSessions.sessions[0],
  agentId: "work",
  sessionId: "session:work:global",
  contextTokens: 300_000,
  totalTokens: 90_000,
};

const claudeSubscriptionAuthStatus = {
  ts: baseTime,
  providers: [
    providerStatus("claude-cli", "Claude", {
      providerId: "anthropic",
      plan: "Max (20x)",
      windows: [
        { label: "5h", usedPercent: 22, resetAt: Date.now() + 4 * 3_600_000 + 48 * 60_000 },
        { label: "Week", usedPercent: 25, resetAt: Date.now() + 2 * 86_400_000 },
        { label: "Fable", usedPercent: 45 },
      ],
      billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
    }),
  ],
};

const claudeSubscriptionSessions = {
  ...gatewayInjectedSessions,
  defaults: {
    contextTokens: 1_000_000,
    model: "claude-fable-5",
    modelProvider: "anthropic",
  },
  sessions: [
    {
      ...gatewayInjectedSessions.sessions[0],
      contextTokens: 1_000_000,
      estimatedCostUsd: 0.02,
      inputTokens: 2_400,
      model: "claude-fable-5",
      // sessions.list canonicalizes CLI aliases; plan matching goes through
      // the auth row's usage.providerId.
      modelProvider: "anthropic",
      outputTokens: 830,
      totalTokens: 78_700,
    },
  ],
};

async function withChat(
  authStatus: unknown,
  sessions: unknown,
  run: (page: Page) => Promise<void>,
) {
  await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
    const gateway = await installMockGateway(page, {
      methodResponses: { "models.authStatus": authStatus, "sessions.list": sessions },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("models.authStatus");
    await run(page);
  });
}

function expectTextExcludes(text: string, ...excluded: string[]) {
  for (const value of excluded) {
    expect(text).not.toContain(value);
  }
}

const visiblePaneSelector = "openclaw-chat-pane.chat-pane-cache__pane--visible";
const loadingWorkAuth = {
  account: null,
  agentId: "work",
  displayName: null,
  error: null,
  plan: null,
  ts: null,
};
type ChatPane = HTMLElement & {
  state?: {
    assistantAgentId?: string | null;
    assistantName?: string;
    assistantAvatar?: string | null;
    chatAvatarUrl?: string | null;
    requestUpdate?: () => void;
    modelAuthStatusError?: string | null;
    modelAuthStatusResult?: {
      ts?: number;
      providers?: Array<{ displayName?: string; usage?: { accountEmail?: string; plan?: string } }>;
    } | null;
  };
};

async function captureOwnership(
  page: Page,
  name: string,
  target = page.locator(".shell"),
  highlight?: Locator,
) {
  if (captureOwnershipProof) {
    await writeFile(
      path.join(ownershipProofDir, `${name}.png`),
      await takeControlUiViewportScreenshot(page, target, [
        highlight ?? page.locator(`${visiblePaneSelector} .context-ring`),
      ]),
    );
  }
}

async function setSelectedAgent(page: Page, name: string): Promise<void> {
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.getByRole("button", { name: /Switch agent/ }).click();
  await sidebar.getByRole("menuitem", { name, exact: true }).click();
}

async function replyToAgentMetadata(gateway: MockGatewayControls, agentId: "main" | "work") {
  for (const method of ["models.authStatus", "agent.identity.get"]) {
    const requests = (await gateway.getRequests(method)).filter((request) => {
      const params = request.params;
      return (
        typeof params === "object" &&
        params !== null &&
        "agentId" in params &&
        params.agentId === agentId
      );
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      await gateway.deliverLatest({
        type: "res",
        id: request.id,
        ok: true,
        payload:
          method === "models.authStatus"
            ? agentAuthStatus(agentId)
            : { agentId, name: `${agentId === "main" ? "Stale Main" : "Work"} Agent` },
      });
    }
  }
}

async function visibleAuthState(page: Page) {
  return await page.evaluate((selector) => {
    const pane = document.querySelector<ChatPane>(selector);
    const provider = pane?.state?.modelAuthStatusResult?.providers?.[0];
    return {
      account: provider?.usage?.accountEmail ?? null,
      agentId: pane?.state?.assistantAgentId ?? null,
      displayName: provider?.displayName ?? null,
      error: pane?.state?.modelAuthStatusError ?? null,
      plan: provider?.usage?.plan ?? null,
      ts: pane?.state?.modelAuthStatusResult?.ts ?? null,
    };
  }, visiblePaneSelector);
}

async function openVisibleQuotaPopover(page: Page) {
  const visiblePane = page.locator(visiblePaneSelector);
  const popover = visiblePane.locator(".context-usage__popover");
  if (!(await popover.isVisible())) {
    await visiblePane.locator(".context-ring").click();
  }
  await popover.waitFor({ state: "visible" });
  return popover;
}

suite.define(() => {
  beforeEach(() => {
    artifactDir = createControlUiE2eArtifactDir("chat-quota-pill-93041");
    if (captureOwnershipProof) {
      ownershipProofDir = path.join(artifactDir, "agent-quota-ownership", ownershipProofPhase);
    }
  });
  it("shows high context pressure without a compact action", async () => {
    await withChat(authStatusWithUsage, highPressureSessions, async (page) => {
      const contextRing = page.locator(".context-ring");
      await contextRing.waitFor({ state: "visible" });
      expect(await contextRing.getAttribute("aria-label")).toBe(
        "Session context usage: 190k of 200k (95%)",
      );
      expect(
        await contextRing.evaluate((element) =>
          element.classList.contains("context-ring--warning"),
        ),
      ).toBe(true);
      expect(await page.locator(".context-usage button").count()).toBe(0);
      await page.screenshot({
        path: path.join(artifactDir, "00-high-context-without-compact-action.png"),
      });
    });
  });

  it("renders provider usage inside the desktop context popover", async () => {
    await withChat(authStatusWithUsage, gatewayInjectedSessions, async (page) => {
      const contextRing = page.locator(".context-ring");
      const usageLinks = page.locator('[data-chat-provider-usage="true"]');
      const usageLink = usageLinks.first();
      await contextRing.waitFor({ state: "visible" });
      expect(await usageLink.isVisible()).toBe(false);
      await contextRing.click();
      await usageLink.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-with-context-usage.png") });
      await page.locator(".context-usage__popover").screenshot({
        path: path.join(artifactDir, "02-context-usage-popover.png"),
      });

      expect(await usageLinks.count()).toBe(1);
      expect(await usageLink.getAttribute("href")).toBe("/usage");
      const rows = await page.locator(".context-usage__limit").allTextContents();
      const normalized = rows.map((row) => row.replace(/\s+/g, " ").trim());
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toMatch(/^Weekly Resets .+ 71%$/);
      expect((await page.locator(".context-usage__popover").textContent()) ?? "").not.toContain(
        "Copilot",
      );
      expect(
        (await page.locator('[data-chat-usage-provider="true"]').textContent())
          ?.replace(/\s+/g, " ")
          .trim(),
      ).toBe("Provider: OpenAI");
      const popoverText = (await page.locator(".context-usage__popover").textContent()) ?? "";
      expectTextExcludes(popoverText, "openclaw", "gateway-injected", "Model:");
    });
  });

  it("shows plan bars, credits, and no dollar estimates for subscription sessions", async () => {
    await withChat(claudeSubscriptionAuthStatus, claudeSubscriptionSessions, async (page) => {
      const popover = await openVisibleQuotaPopover(page);
      await popover.screenshot({
        path: path.join(artifactDir, "03-claude-subscription-popover.png"),
      });

      expect(await page.locator(".context-usage__plan-badge").textContent()).toBe("Max (20x)");
      const rows = await page.locator(".context-usage__limit").allTextContents();
      const normalized = rows.map((row) => row.replace(/\s+/g, " ").trim());
      expect(normalized[0]).toMatch(/^5-hour limit Resets .+ 22%$/);
      expect(normalized[1]).toMatch(/^Weekly Resets .+ 25%$/);
      expect(normalized[2]).toBe("Fable 45%");
      expect(normalized[3]).toBe("Usage credits $157.85 of $400.00");

      const popoverText = (await page.locator(".context-usage__popover").textContent()) ?? "";
      expectTextExcludes(popoverText, "Est. cost", "Cost by Type");
      expect(popoverText).toContain("Latest run tokens");
    });
  });

  it("shows no plan usage when no provider usage windows are present", async () => {
    await withChat({ ts: baseTime, providers: [] }, gatewayInjectedSessions, async (page) => {
      const contextRing = page.locator(".context-ring");
      await contextRing.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const pane = document.querySelector<ChatPane>("openclaw-chat-pane");
        return Array.isArray(pane?.state?.modelAuthStatusResult?.providers);
      });
      await contextRing.click();
      const popover = page.locator(".context-usage__popover");
      await popover.waitFor({ state: "visible" });
      await popover.screenshot({ path: path.join(artifactDir, "04-usage-unavailable.png") });
      expect(await page.locator('[data-chat-provider-usage="true"]').count()).toBe(0);
      const popoverText = (await popover.textContent()) ?? "";
      expectTextExcludes(popoverText, "openclaw", "gateway-injected", "Model:");
    });
  });

  it("binds delayed auth and quota presentation to the selected global agent", async () => {
    const context = await suite.browser.newContext({
      ...createControlUiE2eContextOptions(),
      ...(captureOwnershipProof
        ? { recordVideo: { dir: ownershipProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const video = page.video();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const gateway = await installMockGateway(page, {
        assistantAgentId: "main",
        defaultAgentId: "main",
        heldMethods: ["models.authStatus", "agent.identity.get"],
        // The selected agent's session metrics may not have arrived; its transcript
        // still identifies which provider's quota belongs in the popover.
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Ready." }],
            provider: "openai",
          },
        ],
        methodResponses: {
          "agent.identity.get": {
            cases: [
              { match: { agentId: "main" }, response: { agentId: "main", name: "Main Agent" } },
              { match: { agentId: "work" }, response: { agentId: "work", name: "Work Agent" } },
            ],
          },
          "agents.list": agentsList,
          "models.authStatus": {
            cases: [
              { match: { agentId: "main" }, response: agentAuthStatus("main") },
              { match: { agentId: "work" }, response: agentAuthStatus("work") },
            ],
          },
          "sessions.list": {
            // Static rows seed Main; response cases never seed canonical fixture state.
            ...selectedGlobalSessions,
            cases: [
              {
                match: { agentId: "work" },
                response: { ...selectedGlobalSessions, sessions: [workGlobalSession] },
              },
              { response: selectedGlobalSessions },
            ],
          },
          // A Work main alias resolves to Work's canonical global history on
          // the Gateway; it must not borrow the Main-owned list projection.
          "chat.startup": {
            cases: [
              {
                match: { sessionKey: "agent:work:main", agentId: "work" },
                response: {
                  messages: [],
                  sessionId: workGlobalSession.sessionId,
                  sessionInfo: workGlobalSession,
                },
              },
            ],
          },
        },
        sessionKey: "global",
        sessionScope: "global",
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "global"));
      const connectRequest = await gateway.waitForRequest("connect");
      const { client: connectedClient } = connectRequest.params as {
        client: { instanceId: string };
      };
      await gateway.waitForRequest("models.authStatus", { match: { agentId: "main" } });

      expect((await gateway.waitForRequest("chat.startup")).params).toMatchObject({
        sessionKey: "global",
        agentId: "main",
      });
      let popover = await openVisibleQuotaPopover(page);
      const visiblePane = page.locator(visiblePaneSelector);
      expect(await visiblePane.locator('[data-chat-provider-usage="true"]').count()).toBe(0);

      await page.evaluate((selector) => {
        const pane = document.querySelector<ChatPane>(selector);
        if (pane?.state) {
          pane.state.assistantName = "Main Agent";
          pane.state.assistantAvatar = "M";
          pane.state.chatAvatarUrl = "https://example.test/main-avatar.png";
          pane.state.requestUpdate?.();
        }
      }, visiblePaneSelector);
      await setSelectedAgent(page, "Work");
      await expect.poll(async () => (await visibleAuthState(page)).agentId).toBe("work");
      await gateway.waitForRequest("models.authStatus", { match: { agentId: "work" } });
      await expect.poll(() => visibleAuthState(page)).toEqual(loadingWorkAuth);
      await expect
        .poll(() =>
          page.evaluate((selector) => {
            const pane = document.querySelector<ChatPane>(selector);
            return {
              name: pane?.state?.assistantName ?? null,
              avatar: pane?.state?.assistantAvatar ?? null,
              renderedAvatar: pane?.state?.chatAvatarUrl ?? null,
            };
          }, visiblePaneSelector),
        )
        .toEqual({ name: "OpenClaw", avatar: null, renderedAvatar: null });
      await gateway.emitGatewayEvent("presence", {
        presence: [
          {
            instanceId: connectedClient.instanceId,
            user: { id: "operator", name: "Operator" },
            ts: Date.now(),
          },
        ],
      });
      await expect.poll(() => visibleAuthState(page)).toEqual(loadingWorkAuth);
      await captureOwnership(page, "01-work-loading");

      await replyToAgentMetadata(gateway, "main");
      await page.waitForTimeout(100);
      const delayedMainState = await visibleAuthState(page);
      expect(delayedMainState).toEqual(loadingWorkAuth);
      await captureOwnership(page, "02-after-delayed-main");

      await replyToAgentMetadata(gateway, "work");
      await expect
        .poll(() => visibleAuthState(page))
        .toEqual({
          account: "work@example.test",
          agentId: "work",
          displayName: "Work OpenAI",
          error: null,
          plan: "Work Team",
          ts: baseTime + 2,
        });
      await captureOwnership(page, "03-work-settled");
      popover = await openVisibleQuotaPopover(page);
      expect(
        await page.locator(`${visiblePaneSelector} .context-ring`).getAttribute("aria-label"),
      ).toBe("Session context usage: 90k of 300k (30%)");
      expect((await gateway.getRequests("chat.startup")).at(-1)?.params).toMatchObject({
        sessionKey: "agent:work:main",
        agentId: "work",
      });
      await expect.poll(async () => popover.textContent()).toContain("Work Team");
      const settledText = (await popover.textContent()) ?? "";
      expect(settledText).toContain("work@example.test");
      expect(settledText).toContain("24%");
      expectTextExcludes(settledText, "Main Pro", "main@example.test");
      await captureOwnership(
        page,
        "04-work-quota-popover",
        popover,
        popover.locator(".context-usage__limit").first(),
      );
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      if (captureOwnershipProof && video) {
        await video
          .saveAs(path.join(ownershipProofDir, `${ownershipProofPhase}.webm`))
          .catch(() => {});
      }
    }
  });
});
