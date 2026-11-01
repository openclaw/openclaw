import { expect, it } from "vitest";
import type { SidebarSnapshotModel } from "../components/sidebar-snapshot-model.ts";
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
  measuring: boolean;
  operations: Array<{
    operation: string;
    measuring: boolean;
    at: number;
    invalidations: { sent: number; received: number };
    stack?: string;
    value: unknown;
  }>;
  captured: Promise<void>;
  settled: Promise<void>;
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
        await page.clock.install();
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
        const captureNumber = 424242;
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
            let captureReady = () => {};
            const probe: DeletionProbe = {
              sent: 0,
              received: 0,
              wipes: 0,
              writes: 0,
              measuring: false,
              operations: [],
              exchanged: new Promise<void>((resolve) => {
                settle = resolve;
              }),
              captured: new Promise<void>((resolve) => {
                captureReady = resolve;
              }),
              settled: Promise.resolve(),
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
            const capturesRetained = (value: unknown) => {
              const record = value as { model?: SidebarSnapshotModel } | undefined;
              return record?.model?.pinnedSessions.some(
                (row) =>
                  row.key === input.retainedKey &&
                  row.state?.pullRequest?.numbers.includes(input.captureNumber),
              );
            };
            const transactions = new WeakMap<IDBTransaction, { captured: boolean }>();
            const observeTransaction = (transaction: IDBTransaction) => {
              const previous = transactions.get(transaction);
              if (previous) {
                return previous;
              }
              const observed = { captured: false };
              transactions.set(transaction, observed);
              const completed = new Promise<void>((resolve, reject) => {
                transaction.addEventListener(
                  "complete",
                  () => {
                    if (observed.captured) {
                      captureReady();
                    }
                    resolve();
                  },
                  { once: true },
                );
                for (const event of ["abort", "error"]) {
                  transaction.addEventListener(
                    event,
                    () => reject(new Error("Sidebar snapshot transaction failed")),
                    { once: true },
                  );
                }
              });
              probe.settled = Promise.all([probe.settled, completed]).then(() => {});
              return observed;
            };
            const observe = <Args extends unknown[], Result>(
              operation: (...args: Args) => Result,
              counter?: "writes" | "wipes",
            ) =>
              function (this: IDBObjectStore | IDBCursor, ...args: Args) {
                const source = this instanceof IDBCursor ? this.source : this;
                const observed =
                  source instanceof IDBObjectStore && source.name === "sidebarSnapshots"
                    ? observeTransaction(source.transaction)
                    : undefined;
                if (observed && counter) {
                  probe[counter] += 1;
                  probe.operations.push({
                    operation: operation.name,
                    measuring: probe.measuring,
                    at: Date.now(),
                    invalidations: { sent: probe.sent, received: probe.received },
                    stack: new Error("Sidebar snapshot operation").stack,
                    value: args[0],
                  });
                  if (counter === "writes") {
                    observed.captured = Boolean(capturesRetained(args[0]));
                  }
                }
                const result = operation.apply(this, args);
                if (observed && !counter) {
                  const request = result as IDBRequest<unknown[]>;
                  request.addEventListener(
                    "success",
                    () => {
                      observed.captured = request.result.some(capturesRetained);
                    },
                    { once: true },
                  );
                }
                return result;
              };
            // oxlint-disable typescript/unbound-method -- observe preserves native receivers and arguments.
            IDBObjectStore.prototype.getAll = observe(IDBObjectStore.prototype.getAll);
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
            retainedKey: retained.key,
            captureNumber,
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
          // Finish the initial handoff before counting writes caused by deletion.
          await target
            .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
            .waitFor();
        }
        // A saved boot projection can still have a later capture queued. Join a known
        // live projection's transaction before measuring writes caused by deletion.
        for (const target of pages) {
          await evaluateControlUiContext(
            target,
            (app, input) => {
              app.sessions.setPullRequestSummary(input.key, {
                state: "open",
                numbers: [input.number],
              });
            },
            { key: retained.key, number: captureNumber },
          );
          await row(target, retained.key)
            .locator(`[data-pull-request-state="open"][aria-label*="#${captureNumber}"]`)
            .first()
            .waitFor();
          await target.evaluate(() => window.openclawDeletionSnapshotProbe.captured);
        }
        await pauseVirtualClock(page);
        for (const target of pages) {
          await target.evaluate(async () => {
            const probe = window.openclawDeletionSnapshotProbe;
            let accepted: Promise<void>;
            do {
              accepted = probe.settled;
              await accepted;
            } while (accepted !== probe.settled);
            Object.assign(window.openclawDeletionSnapshotProbe, {
              wipes: 0,
              writes: 0,
              measuring: true,
            });
          });
        }
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
        const snapshots = await Promise.all(
          pages.map((target) =>
            target.evaluate(() => {
              const { writes, operations } = window.openclawDeletionSnapshotProbe;
              return { writes, operations };
            }),
          ),
        );
        const writes = snapshots.map((snapshot) => snapshot.writes);
        console.info("deletion-cache-writes-per-two-virtual-minutes", { tail, writes });
        // A subagent deletion also settles its retained parent's child-load targets.
        expect(
          writes.reduce((total, count) => total + count, 0),
          JSON.stringify({ tail, snapshots }, null, 2),
        ).toBeLessThanOrEqual(subagent ? 2 : 1);
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
