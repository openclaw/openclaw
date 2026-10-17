/**
 * Opt-in real-Gateway proof: a published stable Doctor/Gateway owns the initial
 * SQLite state, then the candidate Gateway reopens that same state. This proves
 * persisted-state compatibility, not the public updater or a live Slack API.
 * Like the neighboring Gateway product proofs, it starts source directly and
 * does not consume a candidate package or require the repository E2E build.
 *
 * Install an exact published stable package in an isolated prefix first, then run
 * this file with OPENCLAW_CHANNEL_VISIBILITY_STABLE_CLI=/.../openclaw/openclaw.mjs.
 * Default scope is core sessions with memory explicitly disabled. To additionally
 * prove the real memory worker, set OPENCLAW_CHANNEL_VISIBILITY_MEMORY_PROOF=1;
 * that scope requires this exact candidate's built plugin SDK artifacts.
 * No package installation, provider requests, or channel connections happen here.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { updateSessionLastRoute } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { GATEWAY_TEST_ENV_KEYS } from "./test-helpers.env.js";

const stableCli = process.env.OPENCLAW_CHANNEL_VISIBILITY_STABLE_CLI;
const memoryProof = process.env.OPENCLAW_CHANNEL_VISIBILITY_MEMORY_PROOF === "1";
const proofScope = memoryProof ? "session-and-memory" : "core-session-with-memory-disabled";
const requester = "agent:main:slack:channel:c111:thread:1.001";
const sibling = "agent:main:slack:channel:c111:thread:1.002";
const token = "channel-visibility-synthetic-proof-token";
const query = "cranberryorbit";
const stableWrite = `${query} stable-gateway-write-retained`;

type RecallFixture = {
  key: string;
  id: string;
  marker: string;
  channel: string;
  to: string;
  account?: string;
  space?: string;
  agent?: string;
};

const fixtures: RecallFixture[] = [
  { key: requester, id: "requester", marker: "current-thread", channel: "slack", to: "c111" },
  { key: sibling, id: "sibling", marker: "same-channel-retained", channel: "slack", to: "c111" },
  {
    key: "agent:main:slack:channel:c222:thread:1.003",
    id: "other-channel",
    marker: "excluded-other-channel",
    channel: "slack",
    to: "c222",
  },
  {
    key: "agent:main:slack:channel:c111:thread:1.004",
    id: "other-account",
    marker: "excluded-other-account",
    channel: "slack",
    to: "c111",
    account: "other",
  },
  {
    key: "agent:main:slack:channel:c111:thread:1.005",
    id: "other-workspace",
    marker: "excluded-other-workspace",
    channel: "slack",
    to: "c111",
    space: "t222",
  },
  {
    key: "agent:main:discord:channel:c111:thread:1.006",
    id: "other-provider",
    marker: "excluded-other-provider",
    channel: "discord",
    to: "c111",
  },
  {
    key: "agent:second:slack:channel:c111:thread:1.007",
    id: "other-agent",
    marker: "excluded-other-agent",
    channel: "slack",
    to: "c111",
    agent: "second",
  },
];

/** Remove inherited credentials/proxies from the published package's subprocesses. */
function isolatedChildEnv(): Record<string, string | undefined> {
  const retained = new Set([
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_AGENT_DIR",
  ]);
  return {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => !retained.has(key))
        .map((key) => [key, undefined]),
    ),
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
  };
}

async function seedLegacySources(instance: OpenClawTestInstance): Promise<void> {
  for (const agent of ["main", "second"]) {
    const directory = instance.state.sessionsDir(agent);
    await fs.mkdir(directory, { recursive: true });
    const entries: Record<string, unknown> = {};
    for (const fixture of fixtures.filter((item) => (item.agent ?? "main") === agent)) {
      const sessionFile = path.join(directory, `${fixture.id}.jsonl`);
      const timestamp = "2026-10-01T00:00:00.000Z";
      entries[fixture.key] = {
        sessionId: fixture.id,
        sessionFile,
        updatedAt: Date.parse(timestamp),
        label: fixture.marker,
        ...(fixture.key === sibling
          ? {
              providerOverride: "synthetic-proof",
              modelOverride: "retained-model-override",
              modelOverrideSource: "user",
            }
          : {}),
        chatType: "channel",
        space: fixture.space ?? "t111",
        origin: {
          provider: fixture.channel,
          accountId: fixture.account ?? "default",
          chatType: "channel",
          to: `channel:${fixture.to}`,
        },
        deliveryContext: {
          channel: fixture.channel,
          accountId: fixture.account ?? "default",
          to: `channel:${fixture.to}`,
        },
      };
      await fs.writeFile(
        sessionFile,
        [
          {
            type: "session",
            version: 3,
            id: fixture.id,
            timestamp,
            cwd: instance.state.workspaceDir,
          },
          {
            type: "message",
            id: `${fixture.id}-message`,
            parentId: null,
            timestamp,
            message: {
              role: "user",
              content: `${query} ${fixture.marker}`,
              timestamp: Date.parse(timestamp),
            },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
      );
    }
    await fs.writeFile(path.join(directory, "sessions.json"), JSON.stringify(entries) + "\n");
  }
}

describe.skipIf(!stableCli)("published stable to channel-scoped Gateway recall", () => {
  // One process transition owns this proof; the slower opt-in case is not a unit-test substitute.
  it(
    `retains stable SQLite history with retrieval-only ${proofScope} scope`,
    { timeout: 180_000 },
    async ({ signal }) => {
      if (!stableCli) {
        throw new Error("OPENCLAW_CHANNEL_VISIBILITY_STABLE_CLI is required for this proof");
      }
      const packageJson: unknown = JSON.parse(
        await fs.readFile(path.join(path.dirname(stableCli), "package.json"), "utf8"),
      );
      expect(packageJson).toMatchObject({
        name: "openclaw",
        version: expect.stringMatching(/^\d+\.\d+\.\d+(?:-\d+)?$/u),
      });
      if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
        throw new Error("Expected the exact installed stable package version");
      }
      const baselineVersion = packageJson.version;
      const envKeys = [...GATEWAY_TEST_ENV_KEYS, "OPENCLAW_HOME", "OPENCLAW_DISABLE_BONJOUR"];
      const snapshot = captureEnv(envKeys);
      let baseline: OpenClawTestInstance | undefined;
      let candidate: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      await runQaGatewayFixture(
        async () => {
          baseline = await createOpenClawTestInstance({
            name: "channel-visibility-stable-upgrade",
            entrypoint: [path.resolve(stableCli)],
            reserveIdlePort: false,
            gatewayToken: token,
            signal,
            env: isolatedChildEnv(),
          });
          const cfg: OpenClawConfig = {
            agents: {
              defaults: { workspace: baseline.state.workspaceDir, skipBootstrap: true },
              entries: { main: {}, second: { workspace: baseline.state.path("second-workspace") } },
            },
            gateway: {
              mode: "local",
              port: baseline.port,
              bind: "loopback",
              auth: { mode: "token", token },
              controlUi: { enabled: false },
              tools: { allow: ["sessions_send", "session_status"] },
            },
            tools: { sessions: { visibility: "self" } },
            skills: { load: { watch: false } },
            // Core scope must not launch an unbuilt memory worker in the
            // background. Full scope uses the real plugin, never a fake result.
            plugins: { slots: { memory: memoryProof ? "memory-core" : "none" } },
            memory: {
              search: {
                provider: "none",
                sources: ["memory", "sessions"],
                experimental: { sessionMemory: true },
                query: { minScore: 0 },
              },
            },
          };
          await baseline.state.writeConfig(cfg);
          await seedLegacySources(baseline);
          const doctor = await baseline.cli(["doctor", "--fix", "--non-interactive", "--yes"], {
            timeoutMs: 60_000,
          });
          expect(doctor.code, doctor.stderr).toBe(0);
          const mainDb = resolveOpenClawAgentSqlitePath({ agentId: "main", env: baseline.env });
          expect((await fs.stat(mainDb)).isFile()).toBe(true);
          await baseline.startGateway();
          const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
            if (!baseline) {
              throw new Error("Stable Gateway fixture is unavailable");
            }
            const result = await baseline.cli(
              [
                "gateway",
                "call",
                method,
                "--url",
                baseline.url,
                "--token",
                token,
                "--timeout",
                "30000",
                "--json",
                "--params",
                JSON.stringify(params),
              ],
              { timeoutMs: 35_000 },
            );
            expect(result.code, result.stderr).toBe(0);
            return JSON.parse(result.stdout);
          };
          expect(
            await rpc("chat.inject", { sessionKey: sibling, message: stableWrite }),
          ).toMatchObject({ ok: true });
          const before = await rpc("chat.history", { sessionKey: sibling, limit: 20 });
          expect(before).toMatchObject({ sessionId: "sibling" });
          expect(JSON.stringify(before)).toContain(stableWrite);
          if (memoryProof) {
            const indexed = await baseline.cli(["memory", "index", "--agent", "main", "--force"], {
              timeoutMs: 60_000,
            });
            expect(indexed.code, indexed.stderr).toBe(0);
          }
          await baseline.stopGateway();

          for (const key of envKeys) {
            const value = baseline.env[key];
            if (value === undefined) {
              deleteTestEnvValue(key);
            } else {
              setTestEnvValue(key, value);
            }
          }
          // Keep the published Doctor's real config migrations (including roster
          // ownership), rather than restoring the pre-Doctor fixture literal.
          const migratedConfig: unknown = JSON.parse(
            await fs.readFile(baseline.configPath, "utf8"),
          );
          if (!isRecord(migratedConfig)) {
            throw new Error("Published Doctor did not retain an object config");
          }
          const candidateConfig = {
            ...migratedConfig,
            tools: {
              ...(isRecord(migratedConfig.tools) ? migratedConfig.tools : {}),
              // Enable the independent thread-target policy so the mutation
              // assertion reaches channel visibility's retrieval-only boundary.
              sessions: { visibility: "channel", allowThreadTargets: true },
            },
          };
          // The candidate's Doctor, not Gateway admission, owns supported schema
          // upgrades. Reuse its offline lock/lease/migration composition (also used
          // by doctor-agent-memory-schema) on the stopped fixture state only.
          const fixtureEnv = baseline.env;
          await withDoctorSqliteMaintenanceLock({
            env: fixtureEnv,
            operation: "channel visibility fixture upgrade",
            run: () =>
              withAgentDatabaseMaintenanceLease({ env: fixtureEnv }, async (maintenance) => {
                for (const agentId of ["main", "second"]) {
                  await migrateOpenClawAgentDatabaseForMaintenance(
                    {
                      agentId,
                      env: fixtureEnv,
                      pathname: resolveOpenClawAgentSqlitePath({ agentId, env: fixtureEnv }),
                    },
                    maintenance,
                  );
                }
              }),
          });
          candidate = await startGatewayWithClient({
            cfg: candidateConfig,
            configPath: baseline.configPath,
            token,
            scopes: ["operator.admin", "operator.read", "operator.write"],
            clientDisplayName: "channel-visibility-upgrade-proof",
          });
          const invoke = async (name: string, args: Record<string, unknown> = {}) => {
            if (!candidate) {
              throw new Error("Candidate Gateway fixture is unavailable");
            }
            // Omitting conversationReadOrigin exercises the delegated/model-facing tool boundary.
            const result = await candidate.client.request<{
              ok: boolean;
              output?: { details?: unknown };
            }>("tools.invoke", { name, args, sessionKey: requester });
            expect(result.ok, JSON.stringify({ tool: name, result })).toBe(true);
            return result.output?.details;
          };
          const history = await invoke("sessions_history", { sessionKey: sibling, limit: 20 });
          expect(JSON.stringify(history)).toContain(stableWrite);
          expect(JSON.stringify(history)).toContain("same-channel-retained");
          for (const fixture of fixtures.slice(2)) {
            expect(await invoke("sessions_history", { sessionKey: fixture.key })).toMatchObject({
              status: "forbidden",
            });
          }
          const listing = await invoke("sessions_list");
          expect(listing).toMatchObject({ count: 2 });
          const search = await invoke("sessions_search", { query });
          const recallResults = [listing, search];
          if (memoryProof) {
            recallResults.push(
              await invoke("memory_search", {
                query,
                corpus: "sessions",
                maxResults: 20,
                minScore: 0,
              }),
            );
          }
          for (const result of recallResults) {
            expect(JSON.stringify(result)).toContain("same-channel-retained");
            for (const fixture of fixtures.slice(2)) {
              expect(JSON.stringify(result)).not.toContain(fixture.marker);
            }
          }
          const siblingSend = await invoke("sessions_send", {
            sessionKey: sibling,
            message: "MUST-NOT-BE-SENT",
            timeoutSeconds: 0,
          });
          expect(siblingSend, JSON.stringify(siblingSend)).toMatchObject({ status: "forbidden" });
          expect(
            await candidate.client.request("tools.invoke", {
              name: "session_status",
              sessionKey: requester,
              args: {},
            }),
          ).toMatchObject({ ok: true });
          // Status uses the existing sanitized RPC error contract. The positive control
          // and unchanged override distinguish denial from a mutation hidden by that error.
          expect(
            await candidate.client.request("tools.invoke", {
              name: "session_status",
              sessionKey: requester,
              args: { sessionKey: sibling, model: "default" },
            }),
          ).toMatchObject({ ok: false, error: { code: "internal_error" } });
          expect(
            await candidate.client.request("sessions.describe", { key: sibling }),
          ).toMatchObject({
            session: { model: "retained-model-override", modelProvider: "synthetic-proof" },
          });
          expect(
            JSON.stringify(
              await candidate.client.request("chat.history", { sessionKey: sibling, limit: 20 }),
            ),
          ).not.toContain("MUST-NOT-BE-SENT");

          await updateSessionLastRoute({
            storePath: mainDb,
            sessionKey: sibling,
            channel: "slack",
            accountId: "default",
            to: "channel:c222",
            createIfMissing: false,
          });
          expect(await invoke("sessions_history", { sessionKey: sibling })).toMatchObject({
            status: "forbidden",
          });
          const reassignedResults = [
            await invoke("sessions_list"),
            await invoke("sessions_search", { query }),
          ];
          if (memoryProof) {
            reassignedResults.push(
              await invoke("memory_search", {
                query,
                corpus: "sessions",
                maxResults: 20,
                minScore: 0,
              }),
            );
          }
          for (const result of reassignedResults) {
            expect(JSON.stringify(result)).not.toContain("same-channel-retained");
            expect(JSON.stringify(result)).not.toContain(stableWrite);
          }
          console.log(
            JSON.stringify({
              proof: "channel-visibility-stable-upgrade",
              scope: proofScope,
              baselineVersion,
              candidateOfflineDoctorMigration: true,
              persistedHistoryRetained: true,
              channelBoundary: true,
              siblingMutationsDenied: true,
              reassignedRouteDenied: true,
              externalApisUsed: false,
              memoryWorkerVerified: memoryProof,
              ...(!memoryProof
                ? {
                    limitation:
                      "Memory worker not exercised; the explicit full scope requires built candidate SDK artifacts.",
                  }
                : {}),
            }),
          );
        },
        async () => {
          if (candidate) {
            await disconnectGatewayClient(candidate.client);
          }
        },
        async () => {
          if (candidate) {
            await candidate.server.close();
          }
        },
        () => closeSkillsWatchers(true),
        async () => {
          if (baseline) {
            await baseline.cleanup();
          }
        },
        () => {
          snapshot.restore();
          clearRuntimeConfigSnapshot();
          clearConfigCache();
          clearSessionStoreCacheForTest();
        },
      );
    },
  );
});
