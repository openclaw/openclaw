import fs from "node:fs";
import path from "node:path";
import "../session-utils-provider.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import * as avatarFiles from "../../agents/identity-avatar-file.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as assistantAvatars from "../assistant-avatar.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { withStateDirEnv } from "../session-utils.test-support.js";
import type { GatewayAgentRow } from "../session-utils.types.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { agentsHandlers } from "./agents.js";
import type { GatewayClient } from "./types.js";

test.each([
  { kind: "local", clientId: "test" },
  { kind: "data", clientId: "test" },
  { kind: "remote", clientId: "test" },
  { kind: "local", clientId: "openclaw-control-ui" },
  { kind: "data", clientId: "openclaw-control-ui" },
] as const)(
  "agents.list omits $kind portraits for $clientId only on opt-out",
  async ({ kind, clientId }) => {
    await withStateDirEnv("agents-list-avatars-", async ({ tempRoot }) => {
      const workspace = path.join(tempRoot, "workspace");
      fs.mkdirSync(workspace);
      const image = Buffer.alloc(32 * 1024, 7);
      fs.writeFileSync(path.join(workspace, "portrait.png"), image);
      const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
      const avatar =
        kind === "local"
          ? "portrait.png"
          : kind === "data"
            ? dataUrl
            : "https://example.com/portrait.png";
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            main: {
              workspace,
              identity: { name: "Research", theme: "science", emoji: "🔬", avatar },
            },
            hidden: { identity: { name: "Private", avatar: dataUrl } },
          },
        },
        gateway: {
          controlUi: { basePath: "/control" },
          roles: {
            definitions: {
              reader: { sessions: { others: "none" }, agents: ["main"], scopes: ["operator.read"] },
            },
          },
        },
      };
      const client: GatewayClient = {
        connect: gatewayConnect(["operator.read"], { id: clientId, mode: "test" }),
        authenticatedUserProfile: gatewayProfile("reader-profile", "Reader"),
        preparedSessionProfile: {
          profileId: "reader-profile",
          aliases: new Set(["reader-profile"]),
          role: "reader",
        },
      };
      const list = async (params: Record<string, unknown>) => {
        const respond = await callAgentHandler(
          expectDefined(agentsHandlers["agents.list"], "agents.list handler"),
          "agents.list",
          params,
          {
            client,
            context: createDirectChatContext({
              getRuntimeConfig: () => cfg,
              readPreparedGatewayModelCatalog: async () => ({ entries: [] }),
            }),
          },
        );
        expect(respond).toHaveBeenCalledTimes(1);
        const [ok, payload, error] = expectDefined(respond.mock.calls[0], "agents.list response");
        expect(error).toBeUndefined();
        expect(ok).toBe(true);
        return payload as { agents: GatewayAgentRow[] };
      };

      using files = vi.spyOn(avatarFiles, "resolveAgentAvatarUrlFromSource");
      using http = vi.spyOn(assistantAvatars, "resolveGatewayAssistantAvatar");
      const lightweight = await list({ includeAvatars: false });
      expect(files).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(lightweight.agents.map(({ id }) => id)).toEqual(["main"]);
      expect(lightweight.agents[0]?.identity).toEqual({
        name: "Research",
        theme: "science",
        emoji: "🔬",
      });
      expect(JSON.stringify(lightweight)).not.toContain(avatar);

      const legacy = await list({});
      const explicit = await list({ includeAvatars: true });
      expect(explicit).toEqual(legacy);
      expect(legacy.agents.map(({ id }) => id)).toEqual(["main"]);
      const identity = legacy.agents[0]?.identity;
      if (clientId === "openclaw-control-ui") {
        expect(identity?.avatarUrl).toMatch(/^\/control\/avatar\/main\?v=[a-f0-9]+$/);
        expect(identity?.avatar).toBe(identity?.avatarUrl);
      } else {
        expect(identity?.avatar).toBe(avatar);
        expect(identity?.avatarUrl).toBe(kind === "remote" ? avatar : dataUrl);
      }
      // All non-image routing, identity, model and authorization facts stay unchanged.
      const withoutImages = structuredClone(legacy);
      delete withoutImages.agents[0]?.identity?.avatar;
      delete withoutImages.agents[0]?.identity?.avatarUrl;
      expect(lightweight).toEqual(withoutImages);
      if (clientId === "test" && kind !== "remote") {
        expect(
          Buffer.byteLength(JSON.stringify(legacy)) -
            Buffer.byteLength(JSON.stringify(lightweight)),
        ).toBeGreaterThan(image.length);
      }
    });
  },
);
