/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import * as uuid from "../../lib/uuid.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext as createCustodianContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-page.tsx";

function createContext(request: Parameters<typeof createCustodianContext>[0]) {
  const calls: string[] = [];
  const refreshList = vi.fn().mockResolvedValue({ mainKey: "main" });
  const { context: base } = createCustodianContext(request);
  const context = {
    ...base,
    gateway: { ...base.gateway, setSessionKey: (key: string) => calls.push(`session:${key}`) },
    agents: { ...base.agents, refreshList },
    agentSelection: {
      ...base.agentSelection,
      set: (id: string | null) => calls.push(`agent:${id}`),
    },
  } satisfies ApplicationContext;
  return { calls, context, refreshList };
}

async function mountPage(context: ApplicationContext) {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-custodian-page");
  page.store = new CustodianSessionStore();
  page.onboarding = false;
  page.newAgentIntent = true;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

let request: Parameters<typeof createCustodianContext>[0];
let harness: ReturnType<typeof createContext>;
const response = {
  sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
  action: "none",
  reply: "Ready.",
};
beforeEach(() => {
  vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  request = vi.fn();
  harness = createContext(request);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("explains the missing capability and scope before sending an agent creation request", async () => {
  const { context } = harness;
  context.gateway.snapshot.hello = {
    ...context.gateway.snapshot.hello!,
    auth: { role: "operator", scopes: ["operator.read"] },
  };

  const page = await mountPage(context);
  await Promise.resolve();

  expect(request).not.toHaveBeenCalled();
  const error = page.querySelector('[role="alert"]')?.textContent;
  for (const text of ["openclaw.chat", "operator.admin", "Pair", "reconnect"]) {
    expect(error).toContain(text);
  }
  expect(error).not.toContain("Update the Gateway");
});

it("refreshes the roster and opens the created agent hatch session", async () => {
  request.mockResolvedValue({
    ...response,
    action: "open-agent",
    agentDraft: "hatch",
    agentId: "researcher",
  });
  const { calls, context, refreshList } = harness;
  await mountPage(context);

  await waitForFast(() => expect(context.navigate).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "new-agent" });
  expect(refreshList).toHaveBeenCalledOnce();
  expect(calls).toEqual(["agent:researcher", "session:agent:researcher:main"]);
  expect(context.navigate).toHaveBeenCalledWith("chat", {
    pathname: "/chat/researcher",
    search: "?draft=Wake%20up%2C%20my%20friend!",
  });
});

it("hands model-account setup to the existing human Profile controls", async () => {
  request.mockResolvedValue({ ...response, handoff: { kind: "model-accounts" } });
  const { calls, context, refreshList } = harness;
  const client = context.gateway.snapshot.client;
  await mountPage(context);

  await waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("profile"));
  expect(context.gateway.snapshot.client).toBe(client);
  expect(refreshList).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
  expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.chat"]);
});
