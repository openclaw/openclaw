import { it, expect } from "vitest";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite(true);
const changedMessage = "changed before deletion. Retry.";

const basicOptions = {
  locale: "en-US",
  serviceWorkers: "block",
} satisfies import("playwright").BrowserContextOptions;

const desktopOptions = { ...basicOptions, viewport: { height: 900, width: 1280 } };

suite.define(() => {
  it.each(["delete", "archive"] as const)(
    "recovers an offline workspace for sidebar %s only after loss consent",
    (action) =>
      suite.withPage(basicOptions, async ({ page }) => {
        const main = sessionRow("agent:main:main", "Main", 2);
        const target = sessionRow("agent:main:offline-workspace", "Offline workspace", 1);
        const method = action === "delete" ? "sessions.delete" : "sessions.patch";
        const gateway = await ui.installSessionRows(page, [main, target], {
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.move"],
          methodResponses: { "sessions.delete": { ok: true, deleted: true } },
          sessionArchiveFiltering: true,
          sessionKey: main.key,
        });
        const row = page.locator(`.sidebar-recent-session[data-session-key="${target.key}"]`);
        const openRecovery = async (after: number) => {
          await gateway.deferNext(method, { key: target.key });
          await ui.visible(row);
          await row.hover();
          await row.click({ button: "right" });
          if (action === "delete") {
            await ui.menuItem(page, "Advanced").click();
          }
          await support.activateSelfRemovingControl(
            ui.menuItem(
              page.locator("openclaw-session-menu"),
              action === "delete" ? "Delete…" : "Archive session",
              false,
            ),
          );
          if (action === "delete") {
            const confirmation = await support.waitForConfirmModal(page);
            await ui.button(confirmation, "Delete").click();
          }
          await gateway.waitForRequest(method, { after, match: { key: target.key } });
          await gateway.rejectDeferred(method, {
            code: "UNAVAILABLE",
            message: "Reconnect the device to preserve its workspace.",
            details: {
              code: "SESSION_WORKSPACE_RECOVERY_REQUIRED",
              cause: "device_offline",
              recoveryAction: "continue_on_gateway",
              sessionId: target.sessionId,
              source: { generation: 5, environmentId: "offline-device", ownerEpoch: 70 },
            },
          });
          const recovery = await support.waitForConfirmModal(page);
          await ui.button(recovery, `Discard changes and ${action}`, false).waitFor();
          await ui.expectText(recovery, "Reconnect it to keep those changes");
          return recovery;
        };

        await page.goto(`${suite.server.baseUrl}chat`);
        const cancelled = await openRecovery(0);
        await ui.button(cancelled, "Cancel").click();
        await cancelled.waitFor({ state: "detached" });
        await ui.visible(row);
        expect(await gateway.getRequests("sessions.move")).toEqual([]);
        await expectRequestCountStable(gateway, method, 1, undefined, { key: target.key });

        const confirmed = await openRecovery(1);
        await gateway.deferNext("sessions.move");
        await ui.button(confirmed, `Discard changes and ${action}`, false).click();
        expect(await gateway.waitForRequest("sessions.move")).toMatchObject({
          params: {
            key: target.key,
            agentId: "main",
            expected: { generation: 5, environmentId: "offline-device", ownerEpoch: 70 },
            target: { kind: "gateway" },
            abandonSource: true,
          },
        });
        await expectRequestCountStable(gateway, method, 2, undefined, { key: target.key });
        if (action === "delete") {
          await gateway.setSessionsListResponse(support.sessionsListResponse([main]));
        }
        await gateway.resolveDeferred("sessions.move", { ok: true });
        await gateway.waitForRequest(method, { after: 2, match: { key: target.key } });
        await row.waitFor({ state: "detached" });
        await expectRequestCountStable(gateway, method, 3, undefined, { key: target.key });
        expect(await gateway.getRequests("sessions.move")).toHaveLength(1);
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
      }),
  );

  it("retires confirmed single and batch drafts in both stores without touching siblings or no-ops", () =>
    suite.withPage(basicOptions, async ({ page }) => {
      const retired = ["single", "batch-a", "batch-b", "external"].map(
        (key) => `agent:main:${key}`,
      );
      const sibling = "agent:main:sibling";
      const noOp = "agent:main:no-op";
      const replacement = "agent:main:replacement";
      const keys = [...retired, sibling, noOp, replacement];

      const gateway = await ui.installSessionRows(
        page,
        keys.map((key, index) => sessionRow(key, key, index)),
        {
          methodResponses: { "sessions.delete": { ok: true, deleted: true } },
          sessionKey: "agent:main:main",
        },
      );
      await page.goto(`${suite.server.baseUrl}sessions`);
      const application = await getControlUiContextHandle(page);
      await page.waitForFunction((app) => {
        const client = app.gateway.snapshot.client;
        return client?.recoveryScopeReady === true && Boolean(client.recoveryScope);
      }, application);
      const storeHandle = await page.evaluateHandle<
        typeof import("../lib/chat/composer-draft-store.runtime.ts")
      >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
      const outboxHandle = await page.evaluateHandle<typeof import("../lib/chat/outbox-store.ts")>(
        'import("/src/lib/chat/outbox-store.ts")',
      );
      const drafts = await application.evaluateHandle(
        async (app, { store, outbox, keys: seededKeys, replacement: replacementKey }) => {
          const client = app.gateway.snapshot.client;
          if (!client?.recoveryScope) {
            throw new Error("Gateway recovery scope unavailable");
          }
          const recoveryScope = client.recoveryScope;
          const { gatewayOwner, key: storageKey } = outbox.storageTargetForGateway(
            client.gatewayUrl,
            recoveryScope,
          );
          const scope = (key: string) => ({
            gatewayOwner,
            recoveryScope,
            scopeKey: `chat:v3:${key}\u0000agent:main`,
          });
          const sessions = Object.fromEntries(
            seededKeys.map((key, index) => [
              `${key}\u0000agent:main`,
              {
                draft: `local ${key}`,
                draftRevision: index + 1,
                updatedAt: index + 1,
                queue: [
                  {
                    id: `queued-${index}`,
                    text: "queued",
                    createdAt: index,
                    storageScope: JSON.stringify([gatewayOwner, recoveryScope]),
                  },
                ],
              },
            ]),
          );
          sessionStorage.setItem(
            storageKey,
            JSON.stringify({ version: 4, gatewayOwner, sessions, recovery: {} }),
          );
          await Promise.all(
            seededKeys.map((key, index) =>
              store.writeDurableComposerDraft(
                scope(key),
                {
                  revision: index + 1,
                  text: `durable ${key}`,
                  attachments: [{ blob: new Blob([key]), mimeType: "text/plain" }],
                },
                { expectedRevision: 0, writeId: `seed-${index}` },
              ),
            ),
          );
          type LocalDraft = {
            draft?: string;
            draftRevision?: number;
            queue?: unknown[];
            updatedAt?: number;
          };
          const readLocal = () =>
            JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
              sessions: Record<string, LocalDraft>;
            };
          return {
            async read(targets: string[]) {
              const local = readLocal();
              return Object.fromEntries(
                await Promise.all(
                  targets.map(async (key) => {
                    const draft = local.sessions?.[`${key}\u0000agent:main`];
                    const durable = await store.readDurableComposerDraft(scope(key));
                    return [
                      key,
                      {
                        local: Boolean(draft?.draft || draft?.queue?.length),
                        durable: durable.status === "found" ? durable.draft.text : durable.status,
                      },
                    ];
                  }),
                ),
              );
            },
            async replace(postConfirmed: boolean) {
              const receipt = postConfirmed
                ? await store.readDurableComposerDraft(scope(replacementKey))
                : undefined;
              if (receipt && receipt.status !== "not-found") {
                throw new Error("confirmed deletion did not leave a durable retirement fence");
              }
              // New edits must advance the retirement fence even when it leads the wall clock.
              const revision = postConfirmed
                ? Math.max(Date.now(), (receipt?.revision ?? 0) + 1)
                : Date.now();
              const local = readLocal();
              local.sessions[`${replacementKey}\u0000agent:main`] = {
                draft: postConfirmed ? "post-confirm local replacement" : "in-flight local edit",
                draftRevision: revision,
                ...(!postConfirmed ? { updatedAt: Date.now() } : {}),
              };
              sessionStorage.setItem(storageKey, JSON.stringify(local));
              const written = await store.writeDurableComposerDraft(
                scope(replacementKey),
                {
                  revision,
                  text: postConfirmed
                    ? "post-confirm durable replacement"
                    : "in-flight durable edit",
                  attachments: [],
                },
                {
                  expectedRevision: postConfirmed ? (receipt?.revision ?? 0) : 7,
                  ...(postConfirmed ? { expectedWriteId: receipt?.writeId } : {}),
                  writeId: postConfirmed ? "post-confirm-replacement" : "in-flight-edit",
                },
              );
              if (postConfirmed && written.status !== "persisted") {
                throw new Error(`post-confirm replacement failed: ${written.status}`);
              }
              return revision;
            },
          };
        },
        { store: storeHandle, outbox: outboxHandle, keys, replacement },
      );
      const deleteSessions = (sessionKeys: string[]) =>
        application.evaluate(
          async (app, targets) =>
            targets.length === 1
              ? await app.sessions.delete(targets[0]!, { agentId: "main" })
              : await app.sessions.deleteMany(targets.map((key) => ({ key, agentId: "main" }))),
          sessionKeys,
        );
      await expect(deleteSessions([retired[0]!])).resolves.toMatchObject({ deleted: true });
      await expect(deleteSessions(retired.slice(1, 3))).resolves.toMatchObject({
        deleted: retired.slice(1, 3),
      });
      await gateway.setMethodResponse("sessions.delete", { ok: true, deleted: false });
      await expect(deleteSessions([noOp])).resolves.toMatchObject({ deleted: false });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: retired[3],
        sessionId: `session:${retired[3]}`,
        agentId: "main",
        reason: "delete",
      });
      await gateway.setMethodResponse("sessions.delete", { ok: true, deleted: true });
      await gateway.deferNext("sessions.delete", { key: replacement });
      const requestsBeforeReplacement = await ui.requestCount(gateway, "sessions.delete");
      const replacementDelete = deleteSessions([replacement]);
      await gateway.waitForRequest("sessions.delete", { after: requestsBeforeReplacement });
      const inFlightRevision = await drafts.evaluate((fixture) => fixture.replace(false));
      await expect
        .poll(() => page.evaluate((revision) => Date.now() > revision, inFlightRevision))
        .toBe(true);
      await gateway.resolveDeferred("sessions.delete", { ok: true, deleted: true });
      await expect(replacementDelete).resolves.toMatchObject({ deleted: true });
      await expect
        .poll(() =>
          drafts.evaluate(async (fixture, key) => (await fixture.read([key]))[key], replacement),
        )
        .toEqual({ local: false, durable: "not-found" });
      await drafts.evaluate((fixture) => fixture.replace(true));
      await expect
        .poll(() => drafts.evaluate((fixture, targets) => fixture.read(targets), keys))
        .toEqual({
          ...Object.fromEntries(
            retired.map((key) => [key, { local: false, durable: "not-found" }]),
          ),
          [sibling]: { local: true, durable: `durable ${sibling}` },
          [noOp]: { local: true, durable: `durable ${noOp}` },
          [replacement]: { local: true, durable: "post-confirm durable replacement" },
        });
      await drafts.dispose();
      await application.dispose();
    }));

  it("keeps rejected sidebar deletion visible without native dialogs or duplicate requests", () =>
    suite.withPage(desktopOptions, async ({ page }) => {
      const key = "agent:main:research";
      const nativeDialogs: string[] = [];
      // Native dialogs must not be required by bridge-less WebViews.
      page.on("dialog", (dialog) => {
        nativeDialogs.push(dialog.message());
        void dialog.dismiss();
      });
      const gateway = await ui.installSessionRows(
        page,
        [
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(key, "Research notes", Date.parse("2026-07-01T15:00:00.000Z")),
        ],
        {
          methodResponses: { "sessions.delete": { ok: true, deleted: true } },
          sessionKey: "agent:main:main",
        },
      );
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await ui.visible(row, 10_000);
      await row.hover();
      await row.click({ button: "right" });
      await ui.menuItem(page, "Advanced").click();
      await ui.menuItem(page.locator("openclaw-session-menu"), "Delete…", false).click();
      const confirmation = await support.waitForConfirmModal(page);
      await gateway.deferNext("sessions.delete");
      await ui.button(confirmation, "Delete").evaluate((control) => {
        if (!(control instanceof HTMLButtonElement)) {
          throw new Error("expected delete confirmation button");
        }
        control.click();
        control.click();
      });
      const request = await gateway.waitForRequest("sessions.delete");
      expect(request).toMatchObject({
        params: { deleteTranscript: true, expectedSessionId: `session:${key}`, key },
      });
      await expectRequestCountStable(gateway, "sessions.delete", 1);
      await gateway.rejectDeferred("sessions.delete", {
        code: "INVALID_REQUEST",
        message: `Session ${key} ${changedMessage}`,
      });
      const error = page.locator("[data-sidebar-session-error]");
      await ui.expectText(error, changedMessage);
      expect(await error.textContent()).not.toContain("GatewayRequestError");
      await ui.visible(row);
      expect(nativeDialogs).toEqual([]);
    }));
});
