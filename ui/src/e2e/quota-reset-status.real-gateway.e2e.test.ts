import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium } from "playwright";
import { describe, expect, inject, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { AuthHealthSummary } from "../../../src/agents/auth-health.js";
import type { ProfileUsageStats } from "../../../src/agents/auth-profiles/types.js";
import { waitForControlUiDocument } from "../../../src/commands/control-ui-handoff.js";
import type { ModelAuthStatusResult } from "../../../src/gateway/server-methods/models-auth-status.types.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../../src/state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../../src/state/openclaw-state-db.paths.js";
import { quotaRequestMode } from "../../../test/e2e/qa-lab/runtime/quota-reset-diagnostics.mjs";
import {
  ACCOUNT_ID,
  MARKER,
  createQuotaResetFixture,
} from "../../../test/e2e/qa-lab/runtime/quota-reset.test-support.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e.js";

type QuotaFixture = Awaited<ReturnType<typeof createQuotaResetFixture>>;
type SavedState = {
  usageStats: Record<string, ProfileUsageStats>;
  [key: string]: unknown;
};
type SavedClearReceipt = {
  pid: number;
  before: SavedState;
  after: SavedState;
  credentialsBefore: string;
  credentialsAfter: string;
  configBefore: string;
  configAfter: string;
};
type ModelsStatus = {
  auth: {
    unusableProfiles: Array<{ profileId: string }>;
    oauth: Pick<AuthHealthSummary, "profiles">;
  };
};

function clearSavedBlock(fixture: QuotaFixture): SavedClearReceipt {
  const script = fileURLToPath(
    new URL(
      "../../../test/e2e/qa-lab/runtime/quota-reset.saved-clear.test-support.mjs",
      import.meta.url,
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      resolveOpenClawStateSqlitePath(fixture.gateway.env),
      fixture.profileId,
      fixture.gateway.configPath,
      String(OPENCLAW_SQLITE_BUSY_TIMEOUT_MS),
    ],
    { env: fixture.gateway.env, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const receipt: SavedClearReceipt = JSON.parse(result.stdout);
  expect(receipt.pid).not.toBe(process.pid);
  expect(receipt.pid).not.toBe(fixture.gateway.child?.pid);
  expect(receipt.credentialsAfter).toBe(receipt.credentialsBefore);
  expect(receipt.configAfter).toBe(receipt.configBefore);
  const beforeUsage = receipt.before.usageStats[fixture.profileId];
  if (!beforeUsage) {
    throw new Error("Saved-block repair did not capture the selected profile usage.");
  }
  const retainedUsage = Object.fromEntries(
    Object.entries(beforeUsage).filter(
      ([key]) =>
        ![
          "blockedUntil",
          "blockedReason",
          "blockedSource",
          "blockedModel",
          "blockedScope",
        ].includes(key),
    ),
  );
  expect(receipt.after).toEqual({
    ...receipt.before,
    usageStats: { ...receipt.before.usageStats, [fixture.profileId]: retainedUsage },
  });
  return receipt;
}

async function captureFinalStatus(
  fixture: QuotaFixture,
  artifactDir: string,
  recordProfile: (profile: unknown) => void,
) {
  const cli = await fixture.gateway.cli(["models", "status", "--json"]);
  expect(cli.code, cli.stderr).toBe(0);
  const status: ModelsStatus = JSON.parse(cli.stdout);
  const profile = status.auth.oauth.profiles.find((entry) => entry.profileId === fixture.profileId);
  recordProfile(profile);
  expect
    .soft(status.auth.unusableProfiles)
    .not.toContainEqual(expect.objectContaining({ profileId: fixture.profileId }));
  // Refreshed fixture credentials stay valid for two days, outside the CLI
  // 24-hour expiry warning; original-credential expiry scenarios remain separate.
  expect.soft(profile).toMatchObject({ profileId: fixture.profileId, type: "oauth", status: "ok" });
  expect.soft(profile?.remainingMs).toBeGreaterThan(0);

  // Gateway readiness does not join its background UI build; dashboard --json intentionally
  // fails immediately while assets are preparing. Wait only at the browser-proof boundary.
  const document = await waitForControlUiDocument({
    url: `http://127.0.0.1:${fixture.gateway.port}/`,
    timeoutMs: 60_000,
  });
  expect(document.ready, JSON.stringify(document)).toBe(true);
  const dashboard = await fixture.gateway.cli(["dashboard", "--json"]);
  const { browserUrl, reason }: { browserUrl: string; reason?: string } = JSON.parse(
    dashboard.stdout,
  );
  expect(dashboard.code, reason ?? dashboard.stderr).toBe(0);
  const url = new URL("settings/model-providers", browserUrl);
  url.hash = new URL(browserUrl).hash;
  const browser = await chromium.launch({
    headless: true,
    executablePath: inject("controlUiE2eChromium").executablePath,
  });
  try {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    await page.addInitScript(() => {
      localStorage.setItem(
        "openclaw:control-ui:community-invite:v2",
        JSON.stringify({ dismissedAtMs: 1770000000000 }),
      );
    });
    try {
      await page.goto(url.href);
      await waitForControlUiGatewayReady(page);
      const card = page.locator('[data-provider-id="openai"]');
      await card.waitFor({ state: "visible" });
      // The ordinary turn already proved automatic quota recovery. Initial catalog
      // publication is best effort; Refresh explicitly asks for its settled status.
      await page.locator(".model-providers__refresh-button").click();
      const badge = card.locator(".model-providers__head .settings-status");
      await expect
        .poll(async () => (await badge.textContent())?.trim(), { timeout: 60_000 })
        .toBe("Ready");
      expect(await page.locator(".community-invite-card").count()).toBe(0);
      await page.screenshot({
        path: path.join(artifactDir, "provider-status.png"),
        animations: "disabled",
      });
    } catch (error) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error: error instanceof Error ? error : new Error("Quota final-status failure"),
        label: "quota-final-status",
      });
      throw error;
    } finally {
      await fs.writeFile(
        path.join(artifactDir, "rendered-page.json"),
        JSON.stringify({ text: await page.locator("body").textContent() }, null, 2),
      );
      if ((await page.locator(".community-invite-card").count()) === 0) {
        await page.screenshot({
          path: path.join(artifactDir, "final-page.png"),
          animations: "disabled",
        });
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

describe.each(["automatic", "saved-clear", "automatic-during-catalog"] as const)(
  "Running Gateway quota status: %s",
  (recovery) => {
    it(
      "serves the same account and shows ready status after recovery without restarting",
      { timeout: 600_000 },
      async (context) => {
        const artifactDir = createControlUiE2eArtifactDir(`quota-refresh-${recovery}`);
        const fixture = await createQuotaResetFixture(context, {
          source: "codex_rate_limits",
          controlUi: true,
        });
        const { gateway, client, provider, turn, stats, advanceClock, clock, evidence } = fixture;
        let finalProfile: unknown;
        const gatewayProcess = gateway.child;
        let catalogHold: ReturnType<typeof provider.holdNextCatalog> | undefined;
        let catalogRefresh:
          | Promise<{ ok: true; result: ModelsListResult } | { ok: false; error: unknown }>
          | undefined;
        expect(gatewayProcess?.pid).toEqual(expect.any(Number));
        try {
          expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
          await expect.poll(() => stats()?.lastProbeAt).toEqual(expect.any(Number));
          provider.setPhase("initial-exhaustion");
          expect((await turn()).status, evidence()).toBe("error");
          const blocked = stats();
          expect(blocked, evidence()).toMatchObject({
            blockedReason: "subscription_limit",
            blockedSource: "codex_rate_limits",
          });
          expect(blocked?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + 86_400_000);
          if (recovery === "automatic-during-catalog") {
            catalogHold = provider.holdNextCatalog();
            await advanceClock();
            catalogRefresh = client
              .request<ModelsListResult>("models.list", {
                agentId: "main",
                view: "configured",
                refresh: true,
              })
              .then(
                (result) => ({ ok: true as const, result }),
                (error: unknown) => ({ ok: false as const, error }),
              );
            const captured = await catalogHold.arrived;
            expect(captured.phase, evidence()).toBe("initial-exhaustion");
            expect(stats()?.blockedUntil, evidence()).toBe(blocked?.blockedUntil);
            const discovering = await client.request<ModelsListResult>("models.list", {
              agentId: "main",
              view: "configured",
            });
            expect(discovering.pendingProviders, evidence()).toContain("openai");
          }
          provider.setPhase("restored");

          if (recovery === "automatic") {
            await advanceClock();
          } else if (recovery === "saved-clear") {
            const lastProbeAt = blocked?.lastProbeAt;
            expect(lastProbeAt).toEqual(expect.any(Number));
            if (lastProbeAt === undefined) {
              throw new Error("Recent saved-block proof requires the previous health observation.");
            }
            expect(Date.now() + clock.offset - lastProbeAt).toBeLessThan(300_000);
            clearSavedBlock(fixture);
            expect(stats()?.blockedUntil).toBeUndefined();
            const refreshed = await client.request<ModelAuthStatusResult>("models.authStatus", {
              agentId: "main",
              refresh: true,
            });
            expect(refreshed.unavailable).toBeUndefined();
            expect(clock.offset).toBe(0);
            expect(Date.now() - lastProbeAt).toBeLessThan(300_000);
          }

          // Observe the next turn before CLI or browser reads can affect runtime preparation.
          const beforeRecovery = provider.requests.length;
          let beforeRecoveryReply: ReturnType<typeof stats>;
          if (catalogHold) {
            provider.observeNextSuccess(
              () => {
                beforeRecoveryReply = stats();
              },
              { model: "gpt-5.5", path: "/v1/responses" },
            );
            const auxiliary = await provider.fetch("/v1/responses", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${fixture.access}`,
                "chatgpt-account-id": ACCOUNT_ID,
              },
              body: JSON.stringify({ model: "gpt-5.6-luna", input: [] }),
            });
            expect(auxiliary.status, evidence()).toBe(200);
            await auxiliary.text();
            expect(beforeRecoveryReply, evidence()).toBeUndefined();
          }
          const nextTurn = await turn();
          const inference = provider.requests
            .slice(beforeRecovery)
            .filter((request) => request.path.endsWith("/responses"));
          const primaryInference = inference.filter(({ body }) => {
            const request: unknown = JSON.parse(body ?? "{}");
            return (
              isRecord(request) &&
              request.model === "gpt-5.5" &&
              quotaRequestMode(body) === "inference"
            );
          });
          expect.soft(nextTurn, evidence()).toEqual({ status: "ok", output: [MARKER] });
          expect(primaryInference, evidence()).toHaveLength(1);
          for (const request of inference) {
            expect(request, evidence()).toMatchObject({
              authorization: `Bearer ${fixture.access}`,
              accountId: ACCOUNT_ID,
            });
          }
          expect.soft(stats()?.blockedUntil, evidence()).toBeUndefined();
          expect(gateway.child).toBe(gatewayProcess);
          expect(gatewayProcess?.exitCode).toBeNull();
          if (catalogHold) {
            expect(beforeRecoveryReply, evidence()).toBeDefined();
            expect(beforeRecoveryReply?.blockedUntil, evidence()).toBeUndefined();
            // A cleared persisted block precedes publication of the replacement catalog owner.
            // Keep the old response held until a prepared-only read observes that replacement.
            let published: ModelsListResult | undefined;
            await expect
              .poll(async () => {
                published = await client.request<ModelsListResult>("models.list", {
                  agentId: "main",
                  view: "configured",
                  preparedOnly: true,
                });
                return {
                  pending: published.pendingProviders?.includes("openai") ?? false,
                  available: published.models.some(
                    (model) =>
                      model.provider === "openai" && model.id === "gpt-5.5" && model.available,
                  ),
                };
              })
              .toEqual({ pending: false, available: true });
            expect
              .soft(published?.models, evidence())
              .toContainEqual(
                expect.objectContaining({ provider: "openai", id: "gpt-5.5", available: true }),
              );
            catalogHold.release();
            const refreshed = await catalogRefresh;
            // Recovery changes availability, so the held generation must not publish stale facts.
            expect(refreshed, evidence()).toMatchObject({
              ok: false,
              error: {
                name: "GatewayClientRequestError",
                code: "UNAVAILABLE",
                retryable: true,
                retryAfterMs: 0,
                message: expect.stringContaining("catalog generation was superseded"),
              },
            });
            expect(provider.heldCatalogResponses[0]?.releaseReason, evidence()).toBe("explicit");
          }
          await captureFinalStatus(fixture, artifactDir, (profile) => {
            finalProfile = profile;
          });
          expect(provider.errors, evidence()).toEqual([]);
        } finally {
          catalogHold?.release();
          await catalogRefresh;
          await fs.writeFile(path.join(artifactDir, "gateway-evidence.json"), evidence());
          await fs.writeFile(
            path.join(artifactDir, "quota.public.json"),
            JSON.stringify(await fixture.publicDiagnostics(finalProfile), null, 2),
          );
        }
      },
    );
  },
);
