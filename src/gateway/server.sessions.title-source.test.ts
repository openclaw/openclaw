import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { withTitleProvider, provider } from "./dashboard-session-title.test-support.js";
import { controlUiClient } from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  dispatchInboundMessageMock.mockReset();
  testState.agentConfig = undefined;
});

it("names task-bearing prepare, create, and send requests while preserving controls and manual names", async () => {
  await withTitleProvider(
    "Repair request routing",
    async ({ cfg, workspaceDir, storePath, requests }) => {
      const skillDir = path.join(workspaceDir, "skills", "route-proof");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: route-proof
description: Investigate request routing
---
Handle the supplied task.
`,
      );
      cfg.session = { store: storePath };
      testState.agentConfig = cfg.agents!.defaults;
      const context = {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalogSnapshot: async () => ({
          agentId: "main",
          agentDir: workspaceDir,
          workspaceDir,
          config: cfg,
          catalogComplete: true,
          routeVariants: [],
          entries: cfg.models!.providers![provider]!.models.map(
            ({ id, name, contextWindow, reasoning }) => ({
              id,
              name,
              contextWindow,
              reasoning,
              provider,
            }),
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
      async function request(
        method: Parameters<typeof directSessionReq>[0],
        params: Record<string, unknown>,
      ) {
        const result = await directSessionReq(method, params, options);
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        return result.payload;
      }
      const create = (key: string, fields: Record<string, unknown> = {}) =>
        request("sessions.create", { agentId: "main", key, ...fields });
      const send = (sessionKey: string, message: string, idempotencyKey: string) =>
        request("chat.send", { sessionKey, message, idempotencyKey });
      dispatchInboundMessageMock.mockResolvedValue({
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      });
      const task = "/route_proof /api request routing needs repair";
      const prepared = await request("sessions.title.prepare", { agentId: "main", message: task });
      expect(prepared).toMatchObject({ title: "Repair request routing" });

      const createdKey = "agent:main:dashboard:created-title-source";
      await create(createdKey, { titleSource: task });
      await waitForTitle(createdKey);
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: createdKey, reason: "chat.title" }),
        expect.anything(),
        expect.anything(),
      );

      const sentKey = "agent:main:dashboard:sent-title-source";
      await create(sentKey);
      await send(sentKey, "/status", "title-control");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), { timeout: 20_000 });
      expect(entry(sentKey)?.displayName).toBeUndefined();
      expect(requests).toHaveLength(2);
      await send(sentKey, task, "title-task");
      await waitForTitle(sentKey);

      const manualKey = "agent:main:dashboard:manual-title-source";
      await create(manualKey, { label: "My chosen name", titleSource: task });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), { timeout: 20_000 });
      expect(entry(manualKey)?.label).toBe("My chosen name");
      expect(requests).toHaveLength(3);
      const attachmentKey = "agent:main:dashboard:attachment-title-source";
      await create(attachmentKey);
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
      expect(requests).toHaveLength(4);
      for (const [index, titleRequest] of requests.entries()) {
        const messages = titleRequest.body.messages as Array<{ role: string; content: string }>;
        expect(
          JSON.parse(messages.findLast((message) => message.role === "user")!.content),
        ).toEqual({
          conversationLabelSource:
            index < 3 ? "/api request routing needs repair" : "Repair the attachment incident",
        });
      }
    },
  );
});
