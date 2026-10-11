/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import * as uuid from "../../lib/uuid.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext as createCustodianContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-page.ts";

type TestCustodianPage = HTMLElement & {
  onboarding: boolean;
  newAgentIntent: boolean;
  store: CustodianSessionStore;
  updateComplete: Promise<boolean>;
};

function createContext(request: ReturnType<typeof vi.fn>) {
  const calls: string[] = [];
  const setSessionKey = vi.fn((sessionKey: string) => calls.push(`session:${sessionKey}`));
  const setAgent = vi.fn((agentId: string | null) => calls.push(`agent:${agentId}`));
  const refreshList = vi.fn().mockResolvedValue({
    defaultId: "main",
    mainKey: "main",
    scope: "global",
    agents: [{ id: "main" }, { id: "researcher" }],
  });
  const harness = createCustodianContext(request, ["openclaw.chat"], {
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [
        { id: "main", model: { primary: "openai/gpt-5.5" } },
        { id: "researcher", model: { primary: "openai/gpt-5.5" } },
      ],
    },
  });
  const context = {
    ...harness.context,
    gateway: { ...harness.context.gateway, setSessionKey },
    agents: { ...harness.context.agents, refreshList },
    agentSelection: { ...harness.context.agentSelection, set: setAgent },
  } satisfies ApplicationContext;
  return { calls, context, refreshList, setAgent, setSessionKey };
}

async function mountPage(context: ApplicationContext): Promise<TestCustodianPage> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-custodian-page") as TestCustodianPage;
  page.store = new CustodianSessionStore();
  page.onboarding = false;
  page.newAgentIntent = true;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

describe("custodian new-agent flow", () => {
  beforeEach(() => {
    vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("requests the new-agent welcome variant", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "What should your new agent do?",
      action: "none",
    });
    const { context } = createContext(request);
    await mountPage(context);

    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "new-agent" });
  });

  it("does not misreport limited access as an outdated Gateway", async () => {
    const request = vi.fn();
    const { context } = createContext(request);
    context.gateway.snapshot.hello = {
      ...context.gateway.snapshot.hello!,
      auth: { role: "operator", scopes: ["operator.read"] },
    };

    const page = await mountPage(context);
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("refreshes the roster and opens the created agent hatch session", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Your agent is hatching.",
      action: "open-agent",
      agentDraft: "hatch",
      agentId: "researcher",
    });
    const { calls, context, refreshList, setAgent, setSessionKey } = createContext(request);
    await mountPage(context);

    await waitForFast(() => expect(context.navigate).toHaveBeenCalledOnce());
    expect(refreshList).toHaveBeenCalledOnce();
    expect(setAgent).toHaveBeenCalledWith("researcher");
    expect(setSessionKey).toHaveBeenCalledWith("agent:researcher:main");
    expect(calls).toEqual(["agent:researcher", "session:agent:researcher:main"]);
    expect(context.navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/researcher",
      search: "?draft=Wake%20up%2C%20my%20friend!",
    });
  });

  it("hands model-account setup to the existing human Profile controls", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Open Settings → Profile → Connected accounts to connect your account.",
      action: "none",
      handoff: { kind: "model-accounts" },
    });
    const { context, refreshList, setAgent, setSessionKey } = createContext(request);
    const client = context.gateway.snapshot.client;
    await mountPage(context);

    await waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("profile"));
    expect(context.gateway.snapshot.client).toBe(client);
    expect(refreshList).not.toHaveBeenCalled();
    expect(setAgent).not.toHaveBeenCalled();
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.chat"]);
  });
});
