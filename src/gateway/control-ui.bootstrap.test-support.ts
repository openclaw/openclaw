import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiPluginFrameGrantAck,
} from "./control-ui-contract.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

export function parseBootstrapPayload(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
  return JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
    basePath: string;
    assistantName: string;
    assistantAvatar: string;
    assistantAvatarSource?: string | null;
    assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
    assistantAvatarReason?: string | null;
    assistantAgentId?: string;
    devGitBranch?: string;
    environment?: { label: string; color: string };
    seamColor?: string;
    terminalEnabled: boolean;
    uploadsEnabled: boolean;
    cliAgentsEnabled: boolean;
    automaticallyFetchFavicons: boolean;
    communityInvite: boolean;
    pluginFrameGrants?: ControlUiPluginFrameGrantAck[];
  };
}

export function registerControlUiUploadConfigTests(): void {
  it.each([undefined, true, false])("publishes uploadsEnabled for config %s", async (enabled) => {
    const { res, end } = makeMockHttpResponse();
    await handleControlUiHttpRequest(
      { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
      res,
      { config: { gateway: { uploads: { enabled } } } },
    );
    expect(res.statusCode).toBe(200);
    expect(parseBootstrapPayload(end).uploadsEnabled).toBe(enabled !== false);
  });
}

export function registerControlUiBootstrapConfigTests({
  createControlUiRoot,
  devInstallBranchMock,
}: {
  createControlUiRoot: (indexHtml?: string) => Promise<string>;
  devInstallBranchMock: { branch: string | null };
}): void {
  it.each([undefined, false])("serves bootstrap config JSON with cliAgents=%s", async (enabled) => {
    const tmp = await createControlUiRoot();

    const { res, end } = makeMockHttpResponse();
    const handled = await handleControlUiHttpRequest(
      { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
      res,
      {
        root: { kind: "resolved", path: tmp },
        config: {
          agents: {
            defaults: { workspace: tmp },
            list: [
              {
                id: "roboclaw",
                default: true,
                workspace: tmp,
                identity: {
                  name: "</script><script>alert(1)//",
                  avatar: "</script>.png",
                },
              },
            ],
          },
          ui: { seamColor: "#1A2b3C" },
          gateway: {
            ...(enabled === undefined ? {} : { cliAgents: { enabled } }),
            controlUi: { environment: { label: "edge", color: "amber" } },
          },
        },
      },
    );
    expect(handled).toBe(true);
    const parsed = parseBootstrapPayload(end);
    expect(parsed.basePath).toBe("");
    expect(parsed.assistantName).toBe("</script><script>alert(1)//");
    expect(parsed.assistantAvatar).toBe("A");
    expect(parsed.assistantAvatarStatus).toBe("none");
    expect(parsed.assistantAvatarReason).toBe("missing");
    expect(parsed.assistantAgentId).toBe("roboclaw");
    expect(parsed.seamColor).toBe("#1A2b3C");
    expect(parsed.environment).toEqual({ label: "edge", color: "amber" });
    expect(parsed.terminalEnabled).toBe(true);
    expect(parsed.cliAgentsEnabled).toBe(enabled !== false);
    expect(parsed.automaticallyFetchFavicons).toBe(true);
    expect(parsed.communityInvite).toBe(true);
    expect(parsed.devGitBranch).toBeUndefined();
  });

  it.each(["automaticallyFetchFavicons", "communityInvite"] as const)(
    "projects an explicit %s opt-out into bootstrap config",
    async (key) => {
      const tmp = await createControlUiRoot();

      const { res, end } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
        res,
        {
          root: { kind: "resolved", path: tmp },
          config: {
            gateway: { controlUi: { [key]: false } },
          },
        },
      );

      expect(handled).toBe(true);
      expect(parseBootstrapPayload(end)[key]).toBe(false);
    },
  );

  it("includes the dev checkout branch in bootstrap config", async () => {
    devInstallBranchMock.branch = "feat/dev-branch-badge";
    try {
      const tmp = await createControlUiRoot();

      const { res, end } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp }, config: {} },
      );
      expect(handled).toBe(true);
      expect(parseBootstrapPayload(end).devGitBranch).toBe("feat/dev-branch-badge");
    } finally {
      devInstallBranchMock.branch = null;
    }
  });
}
