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

  const invalidWebsiteCases: Array<{
    name: string;
    props: Record<string, unknown>;
    error?: RegExp;
  }> = [
    { name: "missing URL", props: {} },
    { name: "empty URL", props: { url: "" } },
    { name: "relative URL", props: { url: "/dashboard" } },
    { name: "protocol-relative URL", props: { url: "//status.example" } },
    { name: "HTTP URL", props: { url: "http://status.example" } },
    { name: "script URL", props: { url: "javascript:alert(1)" } },
    { name: "data URL", props: { url: "data:text/html,<script>alert(1)</script>" } },
    ...[
      { name: "userinfo", username: "example-user", password: "example-password" },
      { name: "username-only", username: "example-user", password: "" },
      { name: "password-only", username: "", password: "example-password" },
    ].map(({ name, username, password }) => {
      const url = new URL("https://status.example");
      url.username = username;
      url.password = password;
      return { name, props: { url: url.href } };
    }),
    { name: "oversized URL", props: { url: `https://status.example/${"a".repeat(2048)}` } },
    {
      name: "oversized URL shortened by normalization",
      props: { url: `https://status.example/${"a/../".repeat(500)}` },
    },
    {
      name: "oversized props shortened by normalization",
      props: { url: `https://status.example/${"a/../".repeat(2000)}` },
      error: /props exceed 8192/,
    },
    {
      name: "oversized encoded props within the URL character limit",
      props: { url: `${"\u0000".repeat(1400)}https://status.example` },
      error: /props exceed 8192/,
    },
    {
      name: "extra HTML",
      props: { url: "https://status.example", html: "<script>alert(1)</script>" },
    },
    {
      name: "extra sandbox permissions",
      props: { url: "https://status.example", sandbox: "allow-top-navigation" },
    },
  ];
  it.each(invalidWebsiteCases)(
    "rejects invalid website props without changing a saved board: $name",
    async ({ props, error = /Website/ }) => {
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
      await expect(tool.execute("invalid", { ...widget, props })).rejects.toThrow(error);
      expect(await store.getSnapshot({ sessionKey })).toEqual(before);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );
});
