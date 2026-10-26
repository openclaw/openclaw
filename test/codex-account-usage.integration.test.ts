import "../src/test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
import { loadCodexAccountUsageTestFixture } from "../extensions/codex/test-api.js";
import type { OAuthCredential } from "../src/agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "../src/gateway/server-methods/types.js";
import { connectUserModelAccountAsync } from "../src/state/user-model-account-operations.js";
import { connectUserModelAccount } from "../src/state/user-model-accounts.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { observeMainThreadSql } from "../src/test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const { createCodexAccountUsageTestFixture } = await loadCodexAccountUsageTestFixture();

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "uses personal account authority without main-thread SQL (reconnect: %s)",
  async (reconnect) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { handleCodexAccountUsage, readCodexAppServerUsage } =
        createCodexAccountUsageTestFixture();
      const config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        plugins: { enabled: false },
      };
      const owner = ensureProfileForEmail("account-usage@example.test");
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        access: "synthetic-account-access",
        refresh: "synthetic-account-refresh",
        expires: 1_900_000_000_000,
        accountId: "synthetic-account",
      };
      const { authProfileId: profileId } = connectUserModelAccount({
        ownerProfileId: owner.id,
        credential,
        assertCurrent() {},
      });
      vi.mocked(readCodexAppServerUsage).mockImplementation(async (options) => {
        options.assertCurrent?.();
        expect(options.preparedAuth).toMatchObject({
          kind: "profile",
          profileId,
          store: { profiles: { [profileId]: credential } },
        });
        if (reconnect) {
          const connected = await connectUserModelAccountAsync({
            ownerProfileId: owner.id,
            credential,
            matchesCredential: () => true,
            assertCurrent() {},
          });
          expect(connected.authProfileId).toBe(profileId);
        }
        return {
          rateLimits: {
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            },
          },
        };
      });
      const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
      const params = { agentId: "main", profileId };
      const sql = observeMainThreadSql();
      sql.calibrate();
      try {
        await handleCodexAccountUsage({
          req: { type: "req", id: "personal-usage", method: "codex.accountUsage", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond,
          context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
          hasCurrentClientAuthority: () => true,
        });
        expect(readCodexAppServerUsage, JSON.stringify(respond.mock.calls)).toHaveBeenCalledOnce();
        if (reconnect) {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "UNAVAILABLE" }),
          );
        } else {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              providers: [expect.objectContaining({ provider: "openai" })],
            }),
          );
        }
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  },
);
