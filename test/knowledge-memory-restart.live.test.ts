import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser } from "playwright";
import { expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import { waitForControlUiDocument } from "../src/commands/control-ui-handoff.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX } from "../src/plugin-state/plugin-state-store.kernel.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const model = process.env.OPENCLAW_LIVE_KNOWLEDGE_RESTART_MODEL;
const native = process.env.OPENCLAW_LIVE_KNOWLEDGE_RESTART_RUNTIME === "claude-cli";
const memoryFiles = {
  "MEMORY.md":
    "# Memory\n\n- The Harbor Lane project ships its first public beta on 2027-02-15.\n- Priya Natarajan owns the Harbor Lane billing integration.\n- The team prefers Postgres over MySQL for new services because of its JSON support.\n",
  "memory/2026-10-01.md":
    "# 2026-10-01\n\n- Decided to host the Harbor Lane staging environment in the Frankfurt region to keep data in the EU.\n- Marco Bellini agreed to write the onboarding guide by 2026-10-20.\n",
  "memory/2026-10-02.md":
    "# 2026-10-02\n\n- The weekly Harbor Lane sync moved from Mondays to Tuesdays at 10:00.\n- Lesson: load tests must run against a copy of production data, not synthetic rows; the synthetic run missed the slow invoice query.\n",
  "memory/2026-10-03.md":
    "# 2026-10-03\n\n- Priya Natarajan owns the Harbor Lane billing integration.\n- The Harbor Lane project ships its first public beta on 2027-02-15.\n",
  "memory/2026-10-04.md":
    "# 2026-10-04\n\n- Chose Stripe as the payment processor for Harbor Lane after comparing fees with Adyen.\n- Ines Okafor prefers written design reviews over meetings.\n",
  "memory/2026-10-05.md":
    "# 2026-10-05\n\n- The Harbor Lane mobile app will support iOS 18 and later only.\n- Marco Bellini finished the onboarding guide early, on 2026-10-14.\n",
  "memory/2026-10-06.md":
    "# 2026-10-06\n\n- Ines Okafor will lead the Harbor Lane security review in November 2026.\n- The team agreed to keep feature flags in LaunchDarkly until the beta ships.\n",
};
const scribe = "Scribe · Learn from Memory";

it.skipIf(!isLiveTestEnabled() || !model || process.platform === "win32")(
  "continues a checkpointed Memory import after a Gateway crash without another start",
  { timeout: 600_000 },
  async ({ signal }) => {
    const instance = await createOpenClawTestInstance({
      name: "knowledge-memory-restart-live",
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        ...(native ? { HOME: process.env.HOME } : {}),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
    });
    const base = `http://127.0.0.1:${instance.port}`;
    const selected = Object.entries(memoryFiles);
    const expected = selected.map(([file]) => file);
    const progressDb = resolveOpenClawStateSqlitePath({
      OPENCLAW_STATE_DIR: instance.stateDir,
    });
    let browser: Browser | undefined;
    let observer: GatewayClient | undefined;
    await runQaGatewayFixture(
      async () => {
        for (const [file, text] of selected) {
          const location = path.join(instance.state.workspaceDir, file);
          await fs.mkdir(path.dirname(location), { recursive: true });
          await fs.writeFile(location, text);
        }
        await instance.state.writeConfig({
          gateway: {
            mode: "local",
            bind: "loopback",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
          },
          agents: {
            defaults: {
              workspace: instance.state.workspaceDir,
              model: { primary: model },
              ...(native ? { models: { [model!]: { agentRuntime: { id: "claude-cli" } } } } : {}),
            },
          },
          plugins: { slots: { memory: "knowledge" }, entries: { knowledge: { enabled: true } } },
          tools: { toolSearch: false, deny: ["exec"] },
        });
        await instance.startGateway();
        expect(await waitForControlUiDocument({ url: base, signal })).toEqual({ ready: true });
        const connect = () =>
          acquireGatewayTestClient(
            {
              url: instance.url,
              token: instance.gatewayToken,
              deviceIdentity: loadOrCreateDeviceIdentity({
                path: instance.state.path("proof-observer", "client", "credentials.sqlite"),
              }),
              mode: "test",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            {
              timeoutMs: 30_000,
              timeoutMessage: "Memory proof observer did not connect",
              closeMessage: "Memory proof observer disconnected during connect",
            },
          );
        observer = await connect();

        function completedFiles() {
          const db = new DatabaseSync(progressDb, { readOnly: true });
          try {
            const entries = db
              .prepare(
                "SELECT entry_key, value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ?",
              )
              .all("knowledge", `${RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX}memory-import-progress`);
            return selected
              .filter(([file, contents]) => {
                const digest = createHash("sha256").update(contents).digest("hex");
                return entries.some(
                  (entry) =>
                    String(entry.entry_key).endsWith(`,${JSON.stringify(file)}]`) &&
                    entry.value_json === JSON.stringify(digest),
                );
              })
              .map(([file]) => file);
          } finally {
            db.close();
          }
        }
        const findSession = async () =>
          (
            await observer!.request<SessionsListResult>("sessions.list", { agentId: "main" })
          ).sessions.find((row) => row.displayName === scribe);
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const url = new URL(
          "/plugin?plugin=knowledge&id=overview&p.agent=main&p.view=scribes&p.scribe=memory",
          base,
        );
        url.hash = `token=${instance.gatewayToken}`;
        await page.goto(url.href);
        await page.getByRole("button", { name: "Import…", exact: true }).click();
        await page.getByRole("button", { name: "Start import", exact: true }).click();
        const session = await vi.waitFor(async () => {
          const row = await findSession();
          expect(row).toBeDefined();
          return row!;
        });
        const saved = await vi.waitFor(
          async () => {
            const completed = completedFiles();
            const row = await findSession();
            expect(completed.length >= 2 || row?.status === "done").toBe(true);
            return completed;
          },
          { timeout: 180_000, interval: 500 },
        );
        expect(
          saved.length,
          "the original import did not save a file checkpoint",
        ).toBeGreaterThanOrEqual(2);
        expect(saved.length).toBeLessThan(7);
        expect((await findSession())?.hasActiveRun).toBe(true);
        await browser.close();
        browser = undefined;
        console.log(`Memory import checkpointed ${saved.length}/7 files before SIGKILL`);
        await observer.stopAndWait();
        observer = undefined;
        const oldPid = instance.child?.pid;
        await instance.crashGateway();
        await instance.startGateway();
        expect(instance.child?.pid).not.toBe(oldPid);
        console.log("Replacement Gateway started without another import request");
        observer = await connect();
        await vi.waitFor(
          async () => {
            expect(completedFiles()).toEqual(expected);
            expect(await findSession()).toMatchObject({
              key: session.key,
              status: "done",
              hasActiveRun: false,
            });
          },
          { timeout: 180_000, interval: 750 },
        );
        const lastSave = await observer.request<{ ok: boolean; result: { hits: unknown[] } }>(
          "plugins.sessionAction",
          {
            pluginId: "knowledge",
            actionId: "grep",
            payload: {
              query: "Ines Okafor security review",
              mode: "all",
              kind: "claim",
            },
            agentId: "main",
          },
        );
        expect(lastSave.ok).toBe(true);
        expect(lastSave.result.hits.length).toBeGreaterThan(0);
        expect(
          await Promise.all(
            selected.map(async ([file]) =>
              fs.readFile(path.join(instance.state.workspaceDir, file), "utf8"),
            ),
          ),
        ).toEqual(selected.map(([, text]) => text));
        console.log(
          "The same conversation finished 7/7 files and the Memory sources were unchanged",
        );
      },
      () => browser?.close(),
      () => observer?.stopAndWait(),
      () => instance.cleanup(),
    );
  },
);
