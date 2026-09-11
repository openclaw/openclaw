import { expect, it } from "vitest";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
type Paints = { reveals: number; changed: string[]; seen: string[]; masks: Record<string, number> };
type TraceWindow = typeof window & { startupPaints: Paints };

suite.define(() => {
  it("opens a git-backed agent draft from the sidebar new-session action", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { workspaceGit: true });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const newSessionButton = page.locator("openclaw-app-sidebar .sidebar-brand__new-thread");
      await newSessionButton.waitFor({ state: "visible", timeout: 10_000 });
      await newSessionButton.click();

      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await expect.poll(() => new URL(page.url()).searchParams.get("agent")).toBe("main");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("waits for configured inference before sending the first chat turn", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "openai/startup-model",
      defaultAgentId: "ops",
      heldMethods: ["connect", "sessions.list", "agent.identity.get", "chat.startup"],
      sessions: [
        createControlUiSessionRow("global", "Shared conversation", 1),
        createControlUiSessionRow("agent:ops:notes", "Operations notes", 1),
      ],
      presenceUsers: [
        { id: "self", name: "Self", self: true },
        { id: "other", name: "Other" },
      ],
      historyMessages: [],
      models: [
        {
          available: true,
          id: "startup-model",
          name: "Startup Model",
          provider: "openai",
        },
      ],
      sessionKey: "global",
      sessionScope: "global",
    });

    try {
      await page.addInitScript(() => {
        const trace: Paints = { reveals: 0, changed: [], seen: [], masks: {} };
        (window as TraceWindow).startupPaints = trace;
        const shapes = new Map<string, string>();
        const firstMasks = new Map<string, Element[]>();
        const painted = (element: Element) => {
          const box = element.getBoundingClientRect();
          if (!box.width || !box.height) {
            return false;
          }
          for (let parent: Element | null = element; parent; parent = parent.parentElement) {
            if (Number(getComputedStyle(parent).opacity) === 0) {
              return false;
            }
          }
          return true;
        };
        const sample = () => {
          let revealed = false;
          for (const [region, selector] of [
            ["identity", ".sidebar-agent-card__name-text"],
            ["sessions", ".sidebar-recent-session__name"],
            ["header", ".chat-pane__session-title-text"],
            ["transcript", ".chat-thread .chat-bubble, .agent-chat__welcome"],
          ] as const) {
            const candidates = [...document.querySelectorAll(selector)].filter(painted);
            const masks = candidates.filter((element) => {
              const style = getComputedStyle(element, "::after");
              return (
                style.content !== "none" &&
                style.visibility === "visible" &&
                Number(style.opacity) > 0.99
              );
            });
            if (masks.length && !trace.seen.includes(region)) {
              trace.masks[region] ??= performance.now();
              const shape = JSON.stringify(
                masks.map((element) => {
                  const r = element.getBoundingClientRect();
                  return [r.x, r.y, r.width, r.height];
                }),
              );
              const first = firstMasks.get(region);
              if (
                (first &&
                  (first.length !== masks.length || masks.some((node, i) => node !== first[i]))) ||
                (shapes.has(region) && shapes.get(region) !== shape)
              ) {
                trace.changed.push(region);
              }
              firstMasks.set(region, masks);
              shapes.set(region, shape);
            }
            if (
              !trace.seen.includes(region) &&
              candidates.some(
                (element) =>
                  !element.closest(".startup-chat-skeleton, .startup-sidebar-skeleton") &&
                  getComputedStyle(element).visibility === "visible",
              )
            ) {
              trace.seen.push(region);
              revealed = true;
            }
          }
          if (revealed) {
            trace.reveals += 1;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("connect");
      // Simulate transport latency without depending on either startup implementation's DOM.
      await page.waitForTimeout(200);
      for (const method of ["connect", "sessions.list", "agent.identity.get"]) {
        await gateway.waitForRequest(method);
        await gateway.resolveDeferred(method);
        await page.waitForTimeout(200);
      }
      await expect
        .poll(() => page.evaluate(() => (window as TraceWindow).startupPaints.seen))
        .toEqual(["identity", "sessions", "header"]);
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("agents.list")).toHaveLength(1);
      // chat.startup owns the initial metadata load; the old parallel
      // chat.metadata request was only a synchronization point for this test.
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      await gateway.waitForRequest("models.list");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const sendButton = page.getByRole("button", { name: "Send message" });
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sendButton.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const typing = {
        sessionKey: "global",
        sessionId: "session:global",
        agentId: "ops",
        actor: { type: "human", id: "other", label: "Other" },
        ts: Date.now(),
      };
      const row = page.locator('openclaw-chat-pane [data-virtual-row-key="presence:typing"]');
      await gateway.emitGatewayEvent("session.typing", { ...typing, typing: true });
      await row.waitFor({ state: "attached" });
      await gateway.emitGatewayEvent("session.typing", { ...typing, typing: false });
      await row.waitFor({ state: "detached" });

      await gateway.resolveDeferred("chat.startup", {
        messages: [],
        metadata: {
          commands: [
            {
              acceptsArgs: false,
              description: "Loaded after startup completes",
              name: "startup-ready",
              scope: "text",
              source: "native",
            },
          ],
          models: [
            {
              available: true,
              id: "startup-model",
              name: "Startup Model",
              provider: "openai",
            },
          ],
        },
        sessionId: "session:global",
        thinkingLevel: null,
      });

      await page.locator("openclaw-chat-pane .agent-chat__welcome").waitFor();
      await page.locator(".startup-chat-skeleton").waitFor({ state: "detached" });
      expect(await page.locator("openclaw-chat-pane .chat-virtual-row").count()).toBe(0);
      const trace = await page.evaluate(() => (window as TraceWindow).startupPaints);
      expect(trace.seen).toEqual(["identity", "sessions", "header", "transcript"]);
      expect(trace.reveals).toBeLessThanOrEqual(2);
      expect(Object.keys(trace.masks)).toEqual(trace.seen);
      expect(trace.changed).toEqual([]);

      const prompt = "send after configured inference loads";
      await composer.fill(prompt);
      await sendButton.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sendButton.isEnabled()).toBe(true);
      await sendButton.click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => composer.inputValue(), {
          timeout: 10_000,
        })
        .toBe("");
      const params = requireRecord(sendRequest.params);
      expect(params.message).toBe(prompt);
      expect(params.sessionKey).toBe("global");
      expect(params.agentId).toBe("ops");

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await gateway.emitGatewayEvent("chat", {
        deltaText: "First token visible.",
        message: {
          content: [{ text: "First token visible.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        agentId: "ops",
        sessionKey: "global",
        state: "delta",
      });
      const transcript = page.locator(".chat-thread-inner");
      await transcript.getByText("First token visible.", { exact: true }).waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await expect
        .poll(() => page.locator('[data-chat-model-option="openai/startup-model"]').count())
        .toBe(1);
      await gateway.emitChatFinal({ runId, text: "History race stayed visible." });
      await page
        .locator(".chat-thread-inner")
        .getByText("History race stayed visible.")
        .waitFor({ timeout: 10_000 });
      await composer.fill("/");
      await page.getByRole("option", { name: /\/startup-ready/ }).waitFor({ timeout: 10_000 });
      // Check after both controls render so no late fallback RPC supplied either catalog.
      expect({
        commands: (await gateway.getRequests("commands.list")).length,
        metadata: (await gateway.getRequests("chat.metadata")).length,
        models: (await gateway.getRequests("models.list")).length,
      }).toEqual({ commands: 0, metadata: 0, models: 1 });
      expect(await gateway.getRequests("agents.list")).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("hydrates startup history before revealing settled roster and metadata", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "openai/hydrated-model",
      deferredMethods: [
        "agents.list",
        "chat.metadata",
        "models.list",
        "sessions.list",
        "sessions.subscribe",
      ],
      methodResponses: {
        "chat.startup": {
          messages: [
            {
              content: [
                { text: "Transcript paints while optional startup data loads", type: "text" },
              ],
              role: "assistant",
            },
          ],
          sessionId: "session:agent:main:main",
          sessionInfo: createControlUiSessionRow("agent:main:main", "Current conversation", 1),
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.subscribe");
      await gateway.rejectDeferred("sessions.subscribe");
      await gateway.waitForRequest("chat.startup");
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("chat.metadata");
      await gateway.waitForRequest("models.list");
      const transcript = page.locator("openclaw-chat-pane .chat-thread");
      const message = transcript.getByText("Transcript paints while optional startup data loads", {
        exact: true,
      });
      await message.waitFor({ state: "attached", timeout: 10_000 });
      await expect
        .poll(() => transcript.evaluate((node) => getComputedStyle(node).opacity))
        .toBe("0");
      expect(await gateway.getRequests("agents.list")).toHaveLength(1);

      await gateway.resolveDeferred("agents.list", {
        agents: [{ id: "main", model: { primary: "openai/hydrated-model" }, name: "OpenClaw" }],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      });
      await gateway.resolveDeferred("chat.metadata", { commands: [] });
      await gateway.resolveDeferred("models.list", {
        models: [
          {
            available: true,
            id: "hydrated-model",
            name: "Hydrated Model",
            provider: "openai",
          },
        ],
      });
      await expect
        .poll(() =>
          page.locator("openclaw-chat-pane").evaluate((pane) => {
            const state = (
              pane as HTMLElement & { state?: { chatModelCatalog?: Array<{ id?: string }> } }
            ).state;
            return state?.chatModelCatalog?.map((model) => model.id);
          }),
        )
        .toEqual(["hydrated-model"]);
      await gateway.waitForRequest("sessions.list");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await transcript.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
      await gateway.resolveDeferred("sessions.list");
      await expect
        .poll(() => transcript.evaluate((node) => getComputedStyle(node).opacity))
        .toBe("1");
      await message.waitFor({ state: "visible" });
      expect(await gateway.getRequests("agents.list")).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
