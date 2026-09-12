import { afterEach, describe, expect, it } from "vitest";
import { createDashboardTool } from "../../agents/tools/dashboard-tool.js";
import type { InProcessGatewayCaller } from "../../agents/tools/in-process-gateway.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createBoardHarness } from "./board.test-support.js";

const sessionKey = "agent:main:website";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createWebsiteHarness() {
  const harness = createBoardHarness();
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ) => {
    const respond = await harness.invoke(method, params);
    const [ok, payload, error] = respond.mock.calls[0]!;
    if (!ok) {
      throw new Error(error?.message);
    }
    return payload as T;
  };
  const tool = createDashboardTool({ agentSessionKey: sessionKey, callGateway });
  return { ...harness, tool };
}

describe("website dashboard authoring", () => {
  it("creates, reopens, and updates the live URL through the agent tool without frame credentials", async () => {
    const { tool, invoke, store } = createWebsiteHarness();
    const create = {
      action: "widget_put",
      name: "status",
      title: "Status",
      pluginKind: "session:website",
      props: { url: "https://status.example/overview?view=queue#active" },
      size: "full",
    };
    const created = await tool.execute("create", create);
    expect(created.details).toMatchObject({
      sessionKey,
      revision: 1,
      widgets: [
        {
          name: "status",
          title: "Status",
          pluginKind: "session:website",
          contentOwner: "plugin",
          props: create.props,
          sizeW: 12,
          grantState: "none",
        },
      ],
    });

    closeOpenClawAgentDatabasesForTest();
    const reloaded = await invoke("board.get", { sessionKey });
    const board = reloaded.mock.calls[0]?.[1];
    expect(board).toMatchObject({ revision: 1, widgets: [{ props: create.props }] });
    expect(JSON.stringify(board)).not.toMatch(/viewTicket|frameUrl|sandboxUrl|declared/);

    const updatedProps = { url: "https://status.example/history" };
    await tool.execute("update", { ...create, title: "History", props: updatedProps });
    expect(await store.getSnapshot({ sessionKey })).toMatchObject({
      revision: 2,
      widgets: [{ name: "status", title: "History", revision: 2, props: updatedProps }],
    });
    await tool.execute("remove", { action: "widget_remove", name: "status" });
    expect((await store.getSnapshot({ sessionKey })).widgets).toEqual([]);
  });

  it.each([
    {},
    { url: "" },
    { url: "/dashboard" },
    { url: "//status.example" },
    { url: "http://status.example" },
    { url: "javascript:alert(1)" },
    { url: "data:text/html,<script>alert(1)</script>" },
    { url: "https://user:password@status.example" },
    { url: "https://user@status.example" },
    { url: `https://status.example/${"a".repeat(2048)}` },
    { url: "https://status.example", html: "<script>alert(1)</script>" },
    { url: "https://status.example", sandbox: "allow-top-navigation" },
  ])("rejects invalid website props without changing a saved board: %j", async (props) => {
    const { tool, store, broadcast } = createWebsiteHarness();
    const widget = {
      action: "widget_put",
      name: "status",
      pluginKind: "session:website",
      props: { url: "https://status.example" },
    };
    await tool.execute("create", widget);
    const before = await store.getSnapshot({ sessionKey });
    broadcast.mockClear();
    await expect(tool.execute("invalid", { ...widget, props })).rejects.toThrow(/Website/);
    expect(await store.getSnapshot({ sessionKey })).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
