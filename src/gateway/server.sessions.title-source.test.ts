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
      dispatchInboundMessageMock.mockResolvedValue({
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      });
      const task = "/route_proof /api request routing needs repair";
      const prepared = await directSessionReq<{ title: string | null }>(
        "sessions.title.prepare",
        { agentId: "main", message: task },
        options,
      );
      expect(prepared.ok, JSON.stringify(prepared.error)).toBe(true);
      expect(prepared.payload?.title).toBe("Repair request routing");

      const createdKey = "agent:main:dashboard:created-title-source";
      const created = await directSessionReq(
        "sessions.create",
        { agentId: "main", key: createdKey, titleSource: task },
        options,
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      await vi.waitFor(
        () =>
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: createdKey, storePath })?.displayName,
          ).toBe("Repair request routing"),
        { timeout: 20_000 },
      );
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: createdKey, reason: "chat.title" }),
        expect.anything(),
        expect.anything(),
      );

      const sentKey = "agent:main:dashboard:sent-title-source";
      const empty = await directSessionReq(
        "sessions.create",
        { agentId: "main", key: sentKey },
        options,
      );
      expect(empty.ok, JSON.stringify(empty.error)).toBe(true);
      const control = await directSessionReq(
        "chat.send",
        { sessionKey: sentKey, message: "/status", idempotencyKey: "title-control" },
        options,
      );
      expect(control.ok, JSON.stringify(control.error)).toBe(true);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), { timeout: 20_000 });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: sentKey, storePath })?.displayName,
      ).toBeUndefined();
      expect(requests).toHaveLength(2);
      const sent = await directSessionReq(
        "chat.send",
        { sessionKey: sentKey, message: task, idempotencyKey: "title-task" },
        options,
      );
      expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
      await vi.waitFor(
        () =>
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: sentKey, storePath })?.displayName,
          ).toBe("Repair request routing"),
        { timeout: 20_000 },
      );

      const manualKey = "agent:main:dashboard:manual-title-source";
      expect(
        (
          await directSessionReq(
            "sessions.create",
            { agentId: "main", key: manualKey, label: "My chosen name", titleSource: task },
            options,
          )
        ).ok,
      ).toBe(true);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), { timeout: 20_000 });
      expect(loadSessionEntry({ agentId: "main", sessionKey: manualKey, storePath })?.label).toBe(
        "My chosen name",
      );
      expect(requests).toHaveLength(3);
      const attachmentKey = "agent:main:dashboard:attachment-title-source";
      expect(
        (
          await directSessionReq(
            "sessions.create",
            {
              agentId: "main",
              key: attachmentKey,
            },
            options,
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await directSessionReq(
            "chat.send",
            {
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
            },
            options,
          )
        ).ok,
      ).toBe(true);
      await vi.waitFor(
        () =>
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: attachmentKey, storePath })
              ?.displayName,
          ).toBe("Repair request routing"),
        { timeout: 20_000 },
      );
      expect(requests).toHaveLength(4);
      for (const request of requests.slice(0, 3)) {
        const messages = request.body.messages as Array<{ role: string; content: string }>;
        expect(
          JSON.parse(messages.findLast((message) => message.role === "user")!.content),
        ).toEqual({ conversationLabelSource: "/api request routing needs repair" });
      }
      const attachmentMessages = requests[3]!.body.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(
        JSON.parse(attachmentMessages.findLast((message) => message.role === "user")!.content),
      ).toEqual({ conversationLabelSource: "Repair the attachment incident" });
    },
  );
});
