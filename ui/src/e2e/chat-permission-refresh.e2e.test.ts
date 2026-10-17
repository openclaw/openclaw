import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };

const session = {
  key: "agent:main:permission-refresh",
  kind: "direct",
  label: "Permission refresh",
  permissionMode: "guarded",
  sessionId: "permission-refresh-generation",
  updatedAt: 1,
};

async function permissionControls(page: Page) {
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  const trigger = pane.locator('[data-chat-permission-select="true"]');
  return {
    pane,
    trigger,
    async select(mode: string) {
      await trigger.click();
      await pane.locator(`[data-chat-permission-option="${mode}"]`).click();
    },
    async settled(mode: string) {
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe(mode);
      await expect.poll(() => trigger.isEnabled()).toBe(true);
    },
  };
}

async function expectPermissionError(pane: Locator, text: string) {
  await pane.locator(".chat-error").getByText(text, { exact: false }).waitFor();
}

async function installPermissionSession(page: Page) {
  return installMockGateway(page, {
    sessions: [session],
    methodResponses: {
      "sessions.list": {
        cases: [{ match: { spawnedBy: session.key }, response: chatSessionListResponse([]) }],
      },
    },
    sessionKey: session.key,
  });
}

function permissionEvent(permissionMode: string | null, updatedAt: number) {
  return { ...session, sessionKey: session.key, reason: "patch", permissionMode, updatedAt };
}

const permissionList = (
  permissionMode: string | undefined,
  updatedAt: number,
  sessionId = session.sessionId,
) => chatSessionListResponse([{ ...session, permissionMode, updatedAt, sessionId }]);

suite.define(() => {
  it("keeps a saved permission mode when its list refresh fails", async () => {
    const page = await newChatPage(suite);
    const gateway = await installPermissionSession(page);
    const { pane, trigger, select, settled } = await permissionControls(page);
    await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("guarded");
    const patchMatch = { key: session.key, permissionMode: "workspace" };
    await gateway.deferNext("sessions.patch", patchMatch);

    await select("workspace");
    await gateway.waitForRequest("sessions.patch", { match: patchMatch });
    // Hydration can observe the old permission while its write is still pending.
    await evaluateControlUiContext(page, (context) => context.sessions.list({ agentId: "main" }));
    const listRequests = await gateway.deferNext("sessions.list", rosterMatch);
    await gateway.resolveDeferred("sessions.patch");
    await gateway.waitForRequest("sessions.list", { after: listRequests, match: rosterMatch });
    // Swarm hydration can finish here; the parent must not appear in its own child query.
    await evaluateControlUiContext(page, (application, query) => application.sessions.list(query), {
      spawnedBy: session.key,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
      limit: 10_000,
    });
    await gateway.rejectDeferred("sessions.list", {
      code: "UNAVAILABLE",
      message: "Roster refresh unavailable",
    });

    await settled("workspace");
    await expectPermissionError(pane, "Permissions were saved");
    await expectPermissionError(pane, "Roster refresh unavailable");
  });

  it("keeps a newer permission event after an older patch response arrives", async () => {
    const page = await newChatPage(suite);
    const gateway = await installPermissionSession(page);

    const { trigger, select, settled } = await permissionControls(page);
    await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("guarded");
    const listRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    const patchMatch = { key: session.key, permissionMode: "workspace" };
    await gateway.deferNext("sessions.patch", patchMatch);

    await select("workspace");
    await gateway.waitForRequest("sessions.patch", { match: patchMatch });
    await gateway.deferNext("sessions.list", rosterMatch);
    await gateway.emitGatewayEvent("sessions.changed", permissionEvent("full", 3));
    await expect
      .poll(() =>
        evaluateControlUiContext(
          page,
          (application, key) =>
            application.sessions.state.result?.sessions.find((row) => row.key === key)
              ?.permissionMode,
          session.key,
        ),
      )
      .toBe("full");
    await gateway.waitForRequest("sessions.list", { after: listRequests, match: rosterMatch });
    await gateway.resolveDeferred("sessions.patch", {
      key: session.key,
      entry: {
        permissionMode: "workspace",
        sessionId: session.sessionId,
        updatedAt: 2,
      },
    });

    await settled("full");
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(listRequests + 1);
  });

  it("settles permission patches before reflecting changes and observes remote updates", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": chatSessionListResponse([session]) },
      sessionKey: session.key,
    });

    const { pane, trigger, select, settled } = await permissionControls(page);
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    expect(await trigger.getAttribute("data-chat-select-value")).toBe("guarded");
    expect(
      await trigger.evaluate((element) => ({
        inMeta: element.closest(".agent-chat__composer-meta") != null,
        inModel: element.closest(".chat-composer-model-control") != null,
      })),
    ).toEqual({ inMeta: true, inModel: false });
    const expectPatch = (params: unknown, permissionMode: string) => {
      expect(requireRecord(params)).toMatchObject({
        expectedSessionId: session.sessionId,
        key: session.key,
        permissionMode,
      });
    };

    const firstListCount = await gateway.deferNext("sessions.list", rosterMatch);
    await trigger.click();
    const firstOption = pane.locator('[data-chat-permission-option="default"]');
    await firstOption.waitFor({ state: "visible" });
    const [triggerBox, firstOptionBox] = await Promise.all([
      trigger.boundingBox(),
      firstOption.boundingBox(),
    ]);
    if (!triggerBox || !firstOptionBox) {
      throw new Error("expected permission picker geometry");
    }
    expect(firstOptionBox.y + firstOptionBox.height).toBeLessThanOrEqual(triggerBox.y - 1);
    expect(firstOptionBox.x).toBeGreaterThanOrEqual(triggerBox.x);
    expect(firstOptionBox.x - triggerBox.x).toBeLessThanOrEqual(32);
    await pane.locator('[data-chat-permission-option="workspace"]').click();
    const patchRequest = await gateway.waitForRequest("sessions.patch");
    expectPatch(patchRequest.params, "workspace");
    await waitForRequests(gateway, "sessions.list", firstListCount + 1, rosterMatch);

    // Later patch acknowledgements read canonical state, not injected wire snapshots.
    const workspaceList = permissionList("workspace", 3);
    await gateway.setSessionsListResponse(workspaceList);
    // Snapshot and emit in one browser turn so an earlier request cannot satisfy this event.
    const workspaceEventListCount = await page.evaluate(
      ({ session: eventSession, match }) => {
        const mockGateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!mockGateway) {
          throw new Error("Mock Gateway is not installed");
        }
        const count = mockGateway.findRequests("sessions.list", match).length;
        mockGateway.emit("sessions.changed", eventSession);
        return count;
      },
      { session: permissionEvent("workspace", 3), match: rosterMatch },
    );
    await gateway.resolveDeferred("sessions.list", workspaceList);
    await settled("workspace");
    expect(await trigger.getAttribute("aria-label")).toContain("Workspace");

    // Admit this event's refresh before measuring the next mutation's own roster request.
    await waitForRequests(gateway, "sessions.list", workspaceEventListCount + 1, rosterMatch);
    const secondListCount = await gateway.deferNext("sessions.list", rosterMatch);
    await select("default");
    const patchRequests = await waitForRequests(gateway, "sessions.patch", 2);
    expect(requireRecord(patchRequests[1]?.params)).toMatchObject({
      key: session.key,
      permissionMode: null,
    });
    await waitForRequests(gateway, "sessions.list", secondListCount + 1, rosterMatch);

    const defaultList = permissionList(undefined, 4);
    await gateway.setSessionsListResponse(defaultList);
    await gateway.emitGatewayEvent("sessions.changed", permissionEvent(null, 4));
    await gateway.resolveDeferred("sessions.list", defaultList);
    await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("");
    expect(await trigger.getAttribute("aria-label")).toContain("Default");

    // A rejection still belongs to this pane while its physical session remains current.
    await gateway.deferNext("sessions.patch");
    await select("full");
    const currentPatch = (await waitForRequests(gateway, "sessions.patch", 3))[2];
    expectPatch(currentPatch?.params, "full");
    await gateway.rejectDeferred("sessions.patch", {
      code: "UNAVAILABLE",
      message: "Permission update could not be applied",
    });
    await expectPermissionError(pane, "Failed to update permissions");
    await settled("");

    await gateway.deferNext("sessions.patch");
    await select("full");
    const stalePatch = (await waitForRequests(gateway, "sessions.patch", 4))[3];
    expectPatch(stalePatch?.params, "full");
    const replacementList = permissionList("read-only", 5, "session-after-replacement");
    await gateway.setSessionsListResponse(replacementList);
    const recoveryListCount = await gateway.deferNext("sessions.list", rosterMatch);
    await gateway.rejectDeferred("sessions.patch", {
      code: "INVALID_REQUEST",
      message: "session identity changed; refresh and retry",
    });
    await waitForRequests(gateway, "sessions.list", recoveryListCount + 1, rosterMatch);
    await gateway.resolveDeferred("sessions.list", replacementList);

    await settled("read-only");
    expect(await pane.locator(".chat-error").count()).toBe(0);
  });
});
