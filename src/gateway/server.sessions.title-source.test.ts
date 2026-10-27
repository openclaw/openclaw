import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { withTitleProvider, provider } from "./dashboard-session-title.test-support.js";
import {
  controlUiClient,
  successfulSessionRequest,
} from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import { setupGatewaySessionsHandlerTestHarness } from "./test/server-sessions.test-helpers.js";

setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  dispatchInboundMessageMock.mockReset();
  testState.agentConfig = undefined;
});

it("names task-bearing sends and attachments while ignoring control-only messages", async () => {
  await withTitleProvider(
    "Repair request routing",
    async ({ cfg, workspaceDir, storePath, requests }) => {
      const skillDir = path.join(workspaceDir, "skills", "route-proof");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: route-proof\ndescription: Investigate request routing\n---\nHandle the supplied task.\n",
      );
      testState.agentConfig = cfg.agents!.defaults;
      const context = {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalogSnapshot: async () => ({
          config: cfg,
          catalogComplete: true,
          routeVariants: [],
          entries: cfg.models!.providers![provider]!.models.map((model) =>
            Object.assign({}, model, { provider }),
          ),
        }),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set(["title-observer"]),
      };
      const options = { ...controlUiClient, context };
      const entry = (sessionKey: string) =>
        loadSessionEntry({ agentId: "main", sessionKey, storePath });
      const waitForTitle = (key: string) =>
        vi.waitFor(() => expect(entry(key)?.displayName).toBe("Repair request routing"), {
          timeout: 20_000,
        });
      const request = (
        method: Parameters<typeof successfulSessionRequest>[0],
        params: Record<string, unknown>,
      ) => successfulSessionRequest(method, params, options);
      const send = (sessionKey: string, message: string, idempotencyKey: string) =>
        request("chat.send", { sessionKey, message, idempotencyKey });
      dispatchInboundMessageMock.mockResolvedValue({
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      });
      const task = "/route_proof /api request routing needs repair";
      const sentKey = "agent:main:dashboard:sent-title-source";
      await request("sessions.create", { agentId: "main", key: sentKey });
      await send(sentKey, "/status", "title-control");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), { timeout: 20_000 });
      expect(entry(sentKey)?.displayName).toBeUndefined();
      expect(requests).toHaveLength(0);
      await send(sentKey, task, "title-task");
      await waitForTitle(sentKey);
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: sentKey, reason: "chat.title" }),
        expect.anything(),
        expect.anything(),
      );
      expect(requests).toHaveLength(1);
      const attachmentKey = "agent:main:dashboard:attachment-title-source";
      await request("sessions.create", { agentId: "main", key: attachmentKey });
      await request("chat.send", {
        sessionKey: attachmentKey,
        message: "/status",
        idempotencyKey: "title-attachment",
        attachments: [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "incident.txt",
            content: Buffer.from("Repair the attachment incident").toString("base64"),
          },
        ],
      });
      await waitForTitle(attachmentKey);
      expect(requests).toHaveLength(2);
      for (const [index, titleRequest] of requests.entries()) {
        const messages = titleRequest.body.messages as Array<{ role: string; content: string }>;
        expect(
          JSON.parse(messages.findLast((message) => message.role === "user")!.content),
        ).toEqual({
          conversationLabelSource:
            index === 0 ? "/api request routing needs repair" : "Repair the attachment incident",
        });
      }
    },
  );
});
