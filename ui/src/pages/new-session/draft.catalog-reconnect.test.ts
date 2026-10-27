import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentsListResult } from "../../api/types.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestDraft } from "./draft-controller.test-support.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each([false, true])(
  "reconciles workspace defaults without replacing the agent or draft (retry: %s)",
  async (retry) => {
    const roster = (workspace: string): AgentsListResult => ({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      sessionPlacement: {},
      agents: [
        { id: "main", workspace: "/main", workspaceGit: false },
        { id: "research", workspace, workspaceGit: false },
      ],
    });
    const original = roster("/research");
    const current = roster("/research-next");
    const refreshed = createDeferred<AgentsListResult>();
    let reads = 0;
    const source = createApplicationGateway();
    source.gateway.setSessionKey = vi.fn();
    const hello = gatewayHelloForMethods(["agents.list", "models.list"], ["operator.read"]);
    hello.auth!.recoveryScope = "test-recovery-scope";
    source.publish({
      ...source.gateway.snapshot,
      client: createTestGatewayClient(async (method) => {
        if (method === "agents.list") {
          return ++reads === 1 ? original : reads === 2 ? refreshed.promise : current;
        }
        return method === "models.list" ? { models: [] } : {};
      }),
      phase: "connected",
      hello,
    });
    const agents = createAgentCapability(source.gateway);
    const fixture = createDraftFixture({ gateway: source.gateway });
    const context = { ...fixture.context, agents };
    const draft = createTestDraft(context);
    const expectDraft = (folder: string) => {
      expect(draft.place.folder).toBe(folder);
      expect(draft.submission.message).toBe("Keep my selected agent");
    };
    try {
      await agents.ensureList();
      draft.gateway.synchronize(source.gateway);
      draft.synchronizeSelections();
      draft.place.selectAgentId("research");
      draft.submission.setMessage("Keep my selected agent", []);
      expect(draft.place.folder).toBe("/research");

      source.publish({ ...source.gateway.snapshot, phase: "reconnecting", hello: null });
      draft.gateway.synchronize(source.gateway);
      source.publish({ ...source.gateway.snapshot, phase: "connected", hello });
      draft.gateway.synchronize(source.gateway);
      draft.synchronizeSelections();
      expectDraft("/research");

      const pending = agents.ensureList();
      if (retry) {
        refreshed.reject(new Error("Roster refresh unavailable"));
        await pending;
        draft.synchronizeSelections();
        expectDraft("/research");
      } else {
        refreshed.resolve(current);
        await pending;
      }
      await agents.ensureList();
      draft.synchronizeSelections();
      expect(draft.place.agentId).toBe("research");
      expectDraft("/research-next");
    } finally {
      draft.disconnect();
      fixture.flow.disconnect();
      agents.dispose();
    }
  },
);
