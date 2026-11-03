import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import {
  createCronJob,
  cronJobsListResponse,
  cronListResponseFixture,
} from "../test-helpers/cron.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:cron-inventory-proof";
const now = Date.parse("2026-10-14T06:00:00Z");
const changed = "cron.inventory.changed";
const runtimeEvents = 2;
const held = createCronJob("held", "Held automation", {
  agentId: "main",
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 600_000 },
  sessionTarget: `session:${sessionKey}`,
});
const other = createCronJob("other", "Other session automation", {
  agentId: "main",
  updatedAtMs: 1,
  sessionTarget: "session:agent:main:another-session",
});
const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width: 1440, height: 900 },
};

function inventory(jobs: CronJob[], revision = "inventory-1") {
  return cronListResponseFixture([
    {
      match: { sessionKey },
      response: cronJobsListResponse(jobs, { snapshotRevision: revision }),
    },
    {
      response: cronJobsListResponse([...jobs, other], { snapshotRevision: revision }),
    },
  ]);
}

async function fixture(page: Page, supported = true) {
  await page.clock.install({ time: now });
  const gateway = await installMockGateway(page, {
    sessionKey,
    operatorScopes: ["operator.read"],
    featureEvents: supported ? [changed] : [],
    featureMethods: ["progressCard.get", "cron.list", "cron.status"],
    methodResponses: {
      "progressCard.get": { card: null },
      "cron.status": { enabled: true, jobs: 2 },
      "cron.list": inventory([held]),
      "sessions.list": chatSessionListResponse([
        { key: sessionKey, kind: "direct", label: "Synthetic inventory proof", updatedAt: 1 },
      ]),
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const details = await openChatDetails(page);
  const row = (name: string) => details.getByRole("link", { name: new RegExp(name) });
  await row(held.name).waitFor();
  const settled = () => details.locator('.chat-summary__automations[aria-busy="false"]').waitFor();
  await settled();
  await page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`).waitFor();
  return { page, gateway, details, row, settled };
}

function runtime(job: CronJob, action: "started" | "finished", revision: number) {
  return {
    jobId: job.id,
    action,
    job: {
      id: job.id,
      name: job.name,
      agentId: job.agentId,
      enabled: job.enabled,
      updatedAtMs: revision,
      state:
        action === "started"
          ? { runningAtMs: now }
          : { lastRunAtMs: now, lastRunStatus: "ok", nextRunAtMs: now + 600_000 },
    },
  };
}

suite.define(() => {
  it.each([
    { mode: "advertised", supported: true, tabs: 3, stateOnly: false },
    { mode: "unadvertised", supported: false, tabs: 1, stateOnly: false },
    { mode: "advertised state-only", supported: true, tabs: 3, stateOnly: true },
    { mode: "unadvertised state-only", supported: false, tabs: 1, stateOnly: true },
  ])(
    "handles unrelated cron churn with an $mode inventory event",
    async ({ supported, tabs, stateOnly }) => {
      await suite.withPage(pageOptions, async ({ page, context }) => {
        const clients = [];
        for (let index = 0; index < tabs; index += 1) {
          clients.push(await fixture(index === 0 ? page : await context.newPage(), supported));
        }
        const counts = [];
        for (const { page: clientPage, gateway, row, settled } of clients) {
          const before = (await gateway.getRequests("cron.list")).length;
          const sessionsBefore = (await gateway.getRequests("sessions.list")).length;
          for (let index = 0; index < runtimeEvents; index += 1) {
            const reads = (await gateway.getRequests("cron.list", { sessionKey })).length;
            await gateway.emitGatewayEvent("cron", {
              ...runtime(other, index % 2 ? "finished" : "started", index + 2),
              ...(stateOnly ? { action: "updated" } : {}),
            });
            // The server regression proves state-only commits no longer publish this old companion.
            if (stateOnly && !supported) {
              await gateway.emitGatewayEvent("sessions.changed", {
                sessionKey,
                reason: "cron-binding",
                ts: now + index,
              });
            }
            await clientPage.clock.runFor(1_000);
            if (!supported) {
              await gateway.waitForRequest("cron.list", { after: reads, match: { sessionKey } });
            }
            await settled();
          }
          const current = row(held.name);
          await gateway.emitGatewayEvent("cron", runtime(held, "started", 100));
          await clientPage.clock.runFor(100);
          await current.locator(".session-run-spinner").waitFor();
          await gateway.emitGatewayEvent("cron", runtime(held, "finished", 101));
          await clientPage.clock.runFor(100);
          await current.locator(".session-run-spinner").waitFor({ state: "detached" });
          await current.getByText("Every 10 minutes", { exact: true }).waitFor();
          await settled();
          const additional = (await gateway.getRequests("cron.list")).length - before;
          const additionalSessions =
            (await gateway.getRequests("sessions.list")).length - sessionsBefore;
          counts.push({
            startup: before,
            sessionsStartup: sessionsBefore,
            runtimeEvents,
            additional,
            additionalSessions,
          });
          if (stateOnly && !supported) {
            expect(additional).toBeGreaterThanOrEqual(runtimeEvents);
          } else {
            expect(additional).toBe(supported ? 0 : runtimeEvents);
            expect(additionalSessions).toBe(0);
          }
        }
        console.log(JSON.stringify({ cronInventoryEvents: supported, stateOnly, clients: counts }));
        if (supported) {
          await page.reload();
          const details = await openChatDetails(page);
          await details.getByRole("link", { name: /Held automation/ }).waitFor();
          expect((await clients[0]!.gateway.getRequests("cron.list")).length).toBeLessThanOrEqual(
            counts[0]!.startup,
          );
        }
      });
    },
  );

  it("refreshes definitions and removes a retargeted job using only content-free invalidations", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const { gateway, row, settled } = await fixture(page);
      let revision = 1;
      const publish = async (jobs: CronJob[]) => {
        await gateway.setMethodResponse("cron.list", inventory(jobs, `inventory-${++revision}`));
        await gateway.emitGatewayEvent(changed, undefined);
      };
      const added = createCronJob("added", "New automation", {
        agentId: "main",
        sessionTarget: `session:${sessionKey}`,
      });
      await publish([held, added]);
      await row(added.name).waitFor();
      const edited = { ...added, name: "Edited automation", updatedAtMs: 2 };
      await publish([held, edited]);
      await row(edited.name).waitFor();
      await row(added.name).waitFor({ state: "detached" });
      const paused = { ...edited, enabled: false, updatedAtMs: 3 };
      await publish([held, paused]);
      await row(paused.name).getByText("Paused", { exact: true }).waitFor();
      await publish([held]);
      await row(paused.name).waitFor({ state: "detached" });

      const retargeted = createCronJob("retargeted", "Formerly visible automation", {
        agentId: "main",
        enabled: false,
        sessionTarget: `session:${sessionKey}`,
      });
      await publish([held, retargeted]);
      await row(retargeted.name).waitFor();
      // The authorized replacement omits J; its private new-target event never reaches this reader.
      await publish([held]);
      await row(retargeted.name).waitFor({ state: "detached" });
      await row(held.name).waitFor();
      await settled();
      expect(
        (await gateway.getRequests()).filter(({ method }) =>
          ["cron.add", "cron.update", "cron.remove", "cron.run"].includes(method),
        ),
      ).toEqual([]);
    });
  });
});
