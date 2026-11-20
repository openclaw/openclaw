import { expect, it } from "vitest";
import { listKnownProviderAuthEnvVarNamesCore } from "../src/secrets/provider-env-vars.js";
import { quotaRequestMode } from "./e2e/qa-lab/runtime/quota-reset-diagnostics.mjs";
import {
  ACCOUNT_ID,
  BACKUP_API_KEY,
  BACKUP_MARKER,
  BACKUP_RESPONSES_PATH,
  createQuotaResetFixture,
  syntheticAccessToken,
} from "./e2e/qa-lab/runtime/quota-reset.test-support.js";

it(
  "routes native Codex inference by saved account priority without repinning healthy conversations",
  { timeout: 240_000 },
  async (context) => {
    const { client, turn, provider, profileId } = await createQuotaResetFixture(context, {
      source: "codex_rate_limits",
      extraProfiles: { "openai:B": "B", "openai:C": "C" },
      includeBackup: true,
      responseText: (request) => `ok from ${String(request.accountId)}`,
      env: {
        ...Object.fromEntries(
          listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
        ),
        CODEX_HOME: undefined,
        CODEX_SQLITE_HOME: undefined,
        OPENAI_BASE_URL: undefined,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "localhost,127.0.0.1,::1",
        no_proxy: "localhost,127.0.0.1,::1",
        NODE_USE_ENV_PROXY: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    });
    const order = async (...profileIds: string[]) => {
      expect(
        await client.request("models.authOrderSet", {
          agentId: "main",
          provider: "openai",
          profileIds,
        }),
      ).toMatchObject({ profileIds });
    };
    const expectTurn = async (session: string, ...accounts: string[]) => {
      const offset = provider.requests.length;
      const result = await turn(`agent:main:${session}`);
      const attempts = provider.requests
        .slice(offset)
        .filter((r) => r.path.endsWith("/responses") && quotaRequestMode(r.body) !== "warmup");
      expect(
        attempts.map(({ path, accountId, authorization, body }) => ({
          path,
          accountId,
          authorization,
          model: (JSON.parse(body ?? "null") as { model: string }).model,
        })),
      ).toEqual(
        accounts.map((account) => {
          const backup = account === "backup";
          return {
            path: backup ? BACKUP_RESPONSES_PATH : "/v1/responses",
            accountId: backup ? undefined : account,
            model: backup ? "echo" : "gpt-5.5",
            authorization: `Bearer ${backup ? BACKUP_API_KEY : syntheticAccessToken(undefined, account)}`,
          };
        }),
      );
      expect(result.status).toBe("ok");
      expect(result.output.at(-1)).toBe(
        accounts.at(-1) === "backup" ? BACKUP_MARKER : `ok from ${accounts.at(-1)}`,
      );
    };
    await order(profileId, "openai:B", "openai:C");
    await expectTurn("existing", ACCOUNT_ID);
    await order("openai:B", profileId, "openai:C");
    await expectTurn("fresh", "B");
    await expectTurn("existing", ACCOUNT_ID);
    await client.request("sessions.patch", {
      key: "agent:main:fresh",
      model: `openai/gpt-5.5@${profileId}`,
    });
    await expectTurn("fresh", ACCOUNT_ID);
    provider.exhaustedAccounts.add("B").add(ACCOUNT_ID);
    await expectTurn("quota", "B", ACCOUNT_ID, "C");
    await expectTurn("cooldown", "C");
    provider.exhaustedAccounts.add("C");
    await expectTurn("fallback", "C", "backup");
  },
);
