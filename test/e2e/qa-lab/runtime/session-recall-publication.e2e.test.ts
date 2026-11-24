import { X509Certificate } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../../../src/config/sessions/session-sharing-store.js";
import * as transcriptSearch from "../../../../src/config/sessions/session-transcript-search.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { OperatorScope } from "../../../../src/gateway/operator-scopes.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { ensureProfileForEmail } from "../../../../src/state/user-profiles.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../helpers/tls-fixture.js";
import { isolatedGatewayEnv } from "./gateway-recovery.test-support.js";

// Real Gateway authentication/RPC and native transcript/sharing writes; only pause the completed worker read.
it(
  "withholds a recall hit on the wire when membership ends during its worker read",
  { timeout: 120_000 },
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await withEnvAsync(isolatedGatewayEnv, async () => {
        const user = "recall-viewer@example.test";
        const origin = "https://recall.example.test";
        const scopes: OperatorScope[] = ["operator.read"];
        const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
        const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
        const auth = {
          mode: "trusted-proxy" as const,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes },
          },
          identityScopes: { [user]: scopes },
        };
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          plugins: { enabled: false },
          discovery: { mdns: { mode: "off" } },
          update: { checkOnStart: false },
          tools: { sessions: { visibility: "all" } },
          gateway: {
            mode: "local",
            trustedProxies: ["127.0.0.1", "::1"],
            auth,
            controlUi: { allowedOrigins: [origin] },
            tls: { enabled: true, autoGenerate: false, certPath, keyPath },
            roles: {
              default: "reader",
              definitions: { reader: { scopes, agents: "*", sessions: { others: "invited" } } },
            },
          },
        };
        const gateway = await startGatewayWithClient({
          cfg,
          configPath: state.configPath,
          secure: true,
          tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
          auth,
          origin,
          scopes,
          clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          edgeAuthHeaders: {
            "x-forwarded-user": user,
            "x-forwarded-proto": "https",
            "x-forwarded-for": "192.0.2.7",
          },
          beforeConnect: async (server) => {
            await server.startupSettled;
          },
        });
        try {
          const self = await gateway.client.request<{ profile: { id: string } }>("users.self", {});
          const owner = ensureProfileForEmail("recall-owner@example.test");
          expect(self.profile.id).not.toBe(owner.id);
          const scope = {
            agentId: "main",
            sessionKey: "agent:main:recall-private",
            sessionId: "recall-private",
          };
          await upsertSessionEntryCore(scope, {
            sessionId: scope.sessionId,
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: owner.id },
          });
          await persistSessionTranscriptTurn(scope, {
            cwd: state.workspaceDir,
            updateMode: "none",
            messages: [
              { message: { role: "user", content: "private uniquerecallneedle" }, now: 1 },
            ],
          });
          await addSessionMember(scope, { identityId: self.profile.id, addedBy: owner.id });
          const search = () =>
            gateway.client.request<SessionsSearchResult>("sessions.search", {
              query: "uniquerecallneedle",
              recall: {
                requesterAgentId: "main",
                requesterSessionKey: "agent:main:main",
                visibility: "all",
              },
            });
          // Index preparation is asynchronous; establish the authorized disclosure before the race.
          await vi.waitFor(
            async () => {
              expect((await search()).results).toEqual([
                expect.objectContaining({
                  sessionKey: scope.sessionKey,
                  snippet: expect.stringContaining("private uniquerecallneedle"),
                }),
              ]);
            },
            { timeout: 10_000 },
          );
          const read = transcriptSearch.searchSessionTranscripts;
          const worker = vi
            .spyOn(transcriptSearch, "searchSessionTranscripts")
            .mockImplementationOnce(async (...args) => {
              const page = await read(...args);
              expect(page.hits).toHaveLength(1);
              await removeSessionMember(scope, self.profile.id);
              return page;
            });
          try {
            expect((await search()).results).toEqual([]);
            expect(worker).toHaveBeenCalled();
            expect((await search()).results).toEqual([]);
          } finally {
            worker.mockRestore();
          }
        } finally {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
      });
    });
  },
);
