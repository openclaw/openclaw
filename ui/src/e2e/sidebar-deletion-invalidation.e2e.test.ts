import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Cross-tab sidebar deletion invalidation" });
type DeletionProbe = Record<"sent" | "received" | "wipes" | "writes", number> & {
  exchanged: Promise<void>;
};
declare global {
  interface Window {
    openclawDeletionSnapshotProbe: DeletionProbe;
  }
}

suite.define(() => {
  it.each(["chat:deleted-snapshot", "subagent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])(
    "retires %s once per tab without wiping the sidebar across churn and reload",
    async (tail) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page, context }) => {
        const retained = createControlUiSessionRow(
          "agent:main:chat:retained-snapshot",
          "Retained conversation",
          2,
        );
        const subagent = tail.startsWith("subagent:");
        const deleted = createControlUiSessionRow(
          `agent:main:${tail}`,
          "Deleted conversation",
          1,
          subagent
            ? {
                spawnedBy: retained.key,
                parentSessionKey: retained.key,
                childOwnerSessionKeys: [retained.key],
              }
            : undefined,
        );
        const profileId = "snapshot-operator";
        const entries = [
          ...(subagent ? [] : [`session:${deleted.key}`]),
          `session:${retained.key}`,
        ];
        await context.addInitScript(
          (input) => {
            if (!localStorage.getItem(input.settingsKey)) {
              localStorage.setItem(
                input.settingsKey,
                JSON.stringify({
                  sidebarAgentsMode: "chip",
                  railShortcuts: input.entries,
                  navigationByProfile: { [input.profileId]: { railShortcuts: input.entries } },
                }),
              );
            }
            let settle = () => {};
            const probe: DeletionProbe = {
              sent: 0,
              received: 0,
              wipes: 0,
              writes: 0,
              exchanged: new Promise<void>((resolve) => {
                settle = resolve;
              }),
            };
            window.openclawDeletionSnapshotProbe = probe;
            const matches = (name: string, value: string | null) =>
              name === "openclaw.control.chatSnapshots.invalidate.v1" &&
              value !== null &&
              (JSON.parse(value) as { sessionKey?: string }).sessionKey?.endsWith(
                `\u0000${input.key}`,
              );
            const changed = () => {
              if (probe.sent > 0 && probe.received > 0) {
                settle();
              }
            };
            // oxlint-disable-next-line typescript/unbound-method -- call preserves the native storage receiver.
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (name, value) {
              if (this === localStorage && matches(name, value)) {
                probe.sent += 1;
                changed();
              }
              setItem.call(this, name, value);
            };
            window.addEventListener("storage", (event) => {
              if (event.key && matches(event.key, event.newValue)) {
                probe.received += 1;
                changed();
              }
            });
            const observe = <Args extends unknown[], Result>(
              operation: (...args: Args) => Result,
              counter: "writes" | "wipes",
            ) =>
              function (this: IDBObjectStore | IDBCursor, ...args: Args) {
                const source = this instanceof IDBCursor ? this.source : this;
                if (source instanceof IDBObjectStore && source.name === "sidebarSnapshots") {
                  probe[counter] += 1;
                }
                return operation.apply(this, args);
              };
            // oxlint-disable typescript/unbound-method -- observe preserves native receivers and arguments.
            IDBObjectStore.prototype.delete = observe(IDBObjectStore.prototype.delete, "wipes");
            IDBObjectStore.prototype.put = observe(IDBObjectStore.prototype.put, "writes");
            IDBCursor.prototype.update = observe(IDBCursor.prototype.update, "writes");
            IDBCursor.prototype.delete = observe(IDBCursor.prototype.delete, "wipes");
            // oxlint-enable typescript/unbound-method
          },
          {
            key: deleted.key,
            settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            entries,
            profileId,
          },
        );
        const pages = [page, await context.newPage()];
        const row = (target: typeof page, key: string) =>
          target.locator(`aside.sidebar [data-session-key="${key}"]`);
        const gateways: Array<Awaited<ReturnType<typeof installMockGateway>>> = [];
        for (const target of pages) {
          const gateway = await installMockGateway(target, {
            authMethod: "trusted-proxy",
            authMode: "trusted-proxy",
            awaitInitialRoster: false,
            sessionKey: retained.key,
            sessions: [retained, deleted],
            heldMethods: ["connect"],
            historyMessages: [{ role: "assistant", content: "Retained synthetic transcript." }],
            methodResponses: {
              "sessions.list": {
                ts: 1,
                path: "",
                count: 2,
                sessions: [retained, deleted],
                defaults: { model: null, modelProvider: null, contextTokens: null },
                ownerSessionCounts: [],
              },
            },
            presenceUsers: [
              {
                self: true,
                id: profileId,
                name: "Snapshot Operator",
                identity: { type: "profile", id: profileId },
              },
            ],
            bootstrapPreferences: {
              profileId,
              entries: { "ui.railShortcuts": entries },
            },
          });
          gateways.push(gateway);
          await target.goto(controlUiSessionUrl(suite.server.baseUrl, retained.key));
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          await row(target, retained.key).first().waitFor();
          const deletedRow = row(target, deleted.key);
          if (subagent) {
            // Ephemeral runs are lifecycle targets, never pinnable sidebar destinations.
            expect(await deletedRow.count()).toBe(0);
          } else {
            await deletedRow.first().waitFor();
          }
          await target.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
        }
        for (const target of pages) {
          await target.evaluate(() => {
            Object.assign(window.openclawDeletionSnapshotProbe, { wipes: 0, writes: 0 });
          });
        }
        await page.clock.install();
        await pauseVirtualClock(page);
        for (const gateway of gateways) {
          await gateway.setSessionsListResponse({ sessions: [retained] });
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: deleted.key,
            sessionId: deleted.sessionId,
            agentId: "main",
            reason: "delete",
          });
        }
        for (let step = 0; step < 24; step += 1) {
          for (const [index, target] of pages.entries()) {
            await evaluateControlUiContext(
              target,
              (app, tick) => {
                for (let repeat = 0; repeat < (tick === 0 ? 20 : 1); repeat += 1) {
                  app.sessions.setPullRequestSummary("agent:main:main", {
                    state: "open",
                    numbers: [tick * 20 + repeat + 1],
                  });
                }
              },
              step,
            );
            await gateways[index]!.emitGatewayEvent("tick", {});
          }
          await page.clock.runFor(5_000);
        }
        await page.clock.resume();
        for (const target of pages) {
          await target.evaluate(() => window.openclawDeletionSnapshotProbe.exchanged);
          expect(await target.evaluate(() => window.openclawDeletionSnapshotProbe)).toMatchObject({
            sent: 1,
            received: 1,
            wipes: 0,
          });
          await row(target, deleted.key).first().waitFor({ state: "detached" });
        }
        const writes = await Promise.all(
          pages.map((target) => target.evaluate(() => window.openclawDeletionSnapshotProbe.writes)),
        );
        // A subagent deletion also settles its retained parent's child-load targets.
        expect(writes.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(
          subagent ? 2 : 1,
        );
        console.info("deletion-cache-writes-per-two-virtual-minutes", { tail, writes });
        await page.locator("aside.sidebar").screenshot({
          path: `${suite.artifactDir}/${subagent ? "subagent" : "normal"}-live.png`,
        });
        await page.reload();
        await gateways[0]!.waitForRequest("connect");
        await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
        await row(page, retained.key).first().waitFor();
        expect(await row(page, deleted.key).count()).toBe(0);
        await page.locator("aside.sidebar").screenshot({
          path: `${suite.artifactDir}/${subagent ? "subagent" : "normal"}-cached.png`,
        });
      });
    },
  );
});
