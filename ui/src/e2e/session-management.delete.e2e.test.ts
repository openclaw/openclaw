import { expect, it } from "vitest";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import {
  button as roleButton,
  menuItem,
  visible,
} from "./session-management.compact.test-support.ts";
import {
  activateSelfRemovingControl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForConfirmModal,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

const basicOptions = {
  locale: "en-US",
  serviceWorkers: "block",
} satisfies import("playwright").BrowserContextOptions;

const desktopOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1280 },
} satisfies import("playwright").BrowserContextOptions;

suite.define(() => {
  it.each(["delete", "archive"] as const)(
    "recovers an offline workspace for sidebar %s only after loss consent",
    async (action) => {
      return suite.withPage(basicOptions, async ({ page }) => {
        const main = sessionRow("agent:main:main", "Main", 2);
        const target = sessionRow("agent:main:offline-workspace", "Offline workspace", 1);
        const method = action === "delete" ? "sessions.delete" : "sessions.patch";
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.move"],
          methodResponses: {
            "sessions.delete": { ok: true, deleted: true },
            "sessions.list": sessionsListResponse([main, target]),
          },
          sessionArchiveFiltering: true,
          sessionKey: main.key,
        });
        const row = page.locator(`.sidebar-recent-session[data-session-key="${target.key}"]`);
        const openRecovery = async (after: number) => {
          await gateway.deferNext(method, { key: target.key });
          await visible(row);
          await row.hover();
          await row.click({ button: "right" });
          if (action === "delete") {
            await menuItem(page, "Advanced").click();
          }
          await activateSelfRemovingControl(
            menuItem(
              page.locator("openclaw-session-menu"),
              action === "delete" ? "Delete…" : "Archive session",
              false,
            ),
          );
          if (action === "delete") {
            const confirmation = await waitForConfirmModal(page);
            await roleButton(confirmation, "Delete").click();
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
          const recovery = await waitForConfirmModal(page);
          await roleButton(recovery, `Discard changes and ${action}`, false).waitFor();
          await expect
            .poll(() => recovery.textContent())
            .toContain("Reconnect it to keep those changes");
          return recovery;
        };

        await page.goto(`${suite.server.baseUrl}chat`);
        const cancelled = await openRecovery(0);
        await roleButton(cancelled, "Cancel").click();
        await cancelled.waitFor({ state: "detached" });
        await visible(row);
        expect(await gateway.getRequests("sessions.move")).toEqual([]);
        await expectRequestCountStable(gateway, method, 1, undefined, { key: target.key });

        const confirmed = await openRecovery(1);
        await gateway.deferNext("sessions.move");
        await roleButton(confirmed, `Discard changes and ${action}`, false).click();
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
          await gateway.setSessionsListResponse(sessionsListResponse([main]));
        }
        await gateway.resolveDeferred("sessions.move", { ok: true });
        await gateway.waitForRequest(method, { after: 2, match: { key: target.key } });
        await row.waitFor({ state: "detached" });
        await expectRequestCountStable(gateway, method, 3, undefined, { key: target.key });
        expect(await gateway.getRequests("sessions.move")).toHaveLength(1);
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
      });
    },
  );

  it("retires confirmed single and batch drafts in both stores without touching siblings or no-ops", async () => {
    const retired = [
      "agent:main:single",
      "agent:main:batch-a",
      "agent:main:batch-b",
      "agent:main:external",
    ];
    const sibling = "agent:main:sibling";
    const noOp = "agent:main:no-op";
    const replacement = "agent:main:replacement";
    const keys = [...retired, sibling, noOp, replacement];
    return suite.withPage(basicOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.delete": { ok: true, deleted: true },
          "sessions.list": sessionsListResponse(
            keys.map((key, index) => sessionRow(key, key, index)),
          ),
        },
        sessionKey: "agent:main:main",
      });

      await page.goto(`${suite.server.baseUrl}sessions`);
      const applicationHandle = await getControlUiContextHandle(page);
      await page.waitForFunction((application) => {
        const client = application.gateway.snapshot.client;
        return client?.recoveryScopeReady === true && Boolean(client.recoveryScope);
      }, applicationHandle);
      const draftStore = await page.evaluateHandle<
        typeof import("../lib/chat/composer-draft-store.runtime.ts")
      >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
      const outboxStore = await page.evaluateHandle<typeof import("../lib/chat/outbox-store.ts")>(
        'import("/src/lib/chat/outbox-store.ts")',
      );
      const owner = await applicationHandle.evaluate(
        async (application, { store, outbox, sessionKeys }) => {
          const client = application.gateway.snapshot.client;
          if (!client?.recoveryScope) {
            throw new Error("Gateway recovery scope unavailable");
          }
          const recoveryScope = client.recoveryScope;
          const { gatewayOwner, key: storageKey } = outbox.storageTargetForGateway(
            client.gatewayUrl,
            recoveryScope,
          );
          const sessions = Object.fromEntries(
            sessionKeys.map((key, index) => [
              `${key}\u0000agent:main`,
              {
                draft: `local ${key}`,
                draftRevision: index + 1,
                queue: [
                  {
                    id: `queued-${index}`,
                    text: "queued",
                    createdAt: index,
                    storageScope: JSON.stringify([gatewayOwner, recoveryScope]),
                  },
                ],
                updatedAt: index + 1,
              },
            ]),
          );
          sessionStorage.setItem(
            storageKey,
            JSON.stringify({ version: 4, gatewayOwner, sessions, recovery: {} }),
          );
          await Promise.all(
            sessionKeys.map((key, index) =>
              store.writeDurableComposerDraft(
                { gatewayOwner, recoveryScope, scopeKey: `chat:v3:${key}\u0000agent:main` },
                {
                  revision: index + 1,
                  text: `durable ${key}`,
                  attachments: [{ blob: new Blob([key]), mimeType: "text/plain" }],
                },
                { expectedRevision: 0, writeId: `seed-${index}` },
              ),
            ),
          );
          return { gatewayOwner, recoveryScope, storageKey };
        },
        { store: draftStore, outbox: outboxStore, sessionKeys: keys },
      );
      const deleteSessions = (sessionKeys: string[]) =>
        applicationHandle.evaluate(async (application, targets) => {
          const sessions = application.sessions;
          return targets.length === 1
            ? sessions.delete(targets[0]!, { agentId: "main" })
            : sessions.deleteMany(targets.map((key) => ({ key, agentId: "main" })));
        }, sessionKeys);
      const readDrafts = (sessionKeys: string[]) =>
        page.evaluate(
          async ({ store, keys: targets, scopeOwner }) => {
            const local = JSON.parse(sessionStorage.getItem(scopeOwner.storageKey) ?? "{}") as {
              sessions?: Record<string, { draft?: string; queue?: unknown[] }>;
            };
            return Object.fromEntries(
              await Promise.all(
                targets.map(async (key) => {
                  const scopeKey = `${key}\u0000agent:main`;
                  const localDraft = local.sessions?.[scopeKey];
                  const durable = await store.readDurableComposerDraft({
                    ...scopeOwner,
                    scopeKey: `chat:v3:${scopeKey}`,
                  });
                  return [
                    key,
                    {
                      local: Boolean(localDraft?.draft || localDraft?.queue?.length),
                      durable: durable.status === "found" ? durable.draft.text : durable.status,
                    },
                  ];
                }),
              ),
            );
          },
          { store: draftStore, keys: sessionKeys, scopeOwner: owner },
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
      const requestsBeforeReplacement = (await gateway.getRequests("sessions.delete")).length;
      const replacementDelete = deleteSessions([replacement]);
      await gateway.waitForRequest("sessions.delete", { after: requestsBeforeReplacement });
      const inFlightRevision = await page.evaluate(
        async ({ store, key, scopeOwner }) => {
          const storageKey = scopeOwner.storageKey;
          const local = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
            sessions: Record<string, unknown>;
          };
          const revision = Date.now();
          local.sessions[`${key}\u0000agent:main`] = {
            draft: "in-flight local edit",
            draftRevision: revision,
            updatedAt: Date.now(),
          };
          sessionStorage.setItem(storageKey, JSON.stringify(local));
          await store.writeDurableComposerDraft(
            { ...scopeOwner, scopeKey: `chat:v3:${key}\u0000agent:main` },
            { revision, text: "in-flight durable edit", attachments: [] },
            { expectedRevision: 7, writeId: "in-flight-edit" },
          );
          return revision;
        },
        { store: draftStore, key: replacement, scopeOwner: owner },
      );
      await expect
        .poll(() => page.evaluate((revision) => Date.now() > revision, inFlightRevision))
        .toBe(true);
      await gateway.resolveDeferred("sessions.delete", { ok: true, deleted: true });
      await expect(replacementDelete).resolves.toMatchObject({ deleted: true });

      await expect
        .poll(async () => (await readDrafts([replacement]))[replacement])
        .toEqual({ local: false, durable: "not-found" });

      await page.evaluate(
        async ({ store, key, scopeOwner }) => {
          const storageKey = scopeOwner.storageKey;
          const local = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
            sessions: Record<string, { draft?: string; draftRevision?: number }>;
          };
          const scopeKey = `${key}\u0000agent:main`;
          const durable = await store.readDurableComposerDraft({
            ...scopeOwner,
            scopeKey: `chat:v3:${scopeKey}`,
          });
          if (durable.status !== "not-found") {
            throw new Error("confirmed deletion did not leave a durable retirement fence");
          }
          // Retirement fences can lead the wall clock; a new edit must advance that fence.
          const revision = Math.max(Date.now(), (durable.revision ?? 0) + 1);
          local.sessions[scopeKey] = {
            draft: "post-confirm local replacement",
            draftRevision: revision,
          };
          sessionStorage.setItem(storageKey, JSON.stringify(local));
          const written = await store.writeDurableComposerDraft(
            { ...scopeOwner, scopeKey: `chat:v3:${scopeKey}` },
            { revision, text: "post-confirm durable replacement", attachments: [] },
            {
              expectedRevision: durable.revision ?? 0,
              expectedWriteId: durable.writeId,
              writeId: "post-confirm-replacement",
            },
          );
          if (written.status !== "persisted") {
            throw new Error(`post-confirm replacement failed: ${written.status}`);
          }
        },
        { store: draftStore, key: replacement, scopeOwner: owner },
      );

      await expect
        .poll(() => readDrafts(keys))
        .toEqual({
          [retired[0]!]: { local: false, durable: "not-found" },
          [retired[1]!]: { local: false, durable: "not-found" },
          [retired[2]!]: { local: false, durable: "not-found" },
          [retired[3]!]: { local: false, durable: "not-found" },
          [sibling]: { local: true, durable: `durable ${sibling}` },
          [noOp]: { local: true, durable: `durable ${noOp}` },
          [replacement]: {
            local: true,
            durable: "post-confirm durable replacement",
          },
        });
      await applicationHandle.dispose();
    });
  });

  it("keeps bulk deletion fenced to the session selected before confirmation", async () => {
    const key = "agent:main:confirmed";
    const original = sessionRow(key, "Original session", 1, {
      sessionId: "confirmed-session",
    });
    const replacement = sessionRow(key, "Replacement session", 2, {
      sessionId: "replacement-session",
    });
    return suite.withPage(desktopOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.delete": { ok: true, deleted: true },
          "sessions.list": sessionsListResponse([original]),
        },
        sessionKey: "agent:main:main",
      });

      await page.goto(`${suite.server.baseUrl}sessions`);
      const replacementLabel = page.locator(".sessions-table").getByText("Replacement session", {
        exact: true,
      });
      await page.getByRole("checkbox", { name: `Select session: ${key}` }).check();
      await roleButton(page.locator(".data-table-bulk-bar"), "Delete", false).click();
      const confirmModal = await waitForConfirmModal(page);

      await gateway.setSessionsListResponse(sessionsListResponse([replacement]));
      await gateway.deferNext("sessions.delete");
      await roleButton(confirmModal, "Delete").click();

      const request = await gateway.waitForRequest("sessions.delete");
      expect(request).toMatchObject({
        params: { expectedSessionId: "confirmed-session", key },
      });
      await gateway.rejectDeferred("sessions.delete", {
        code: "INVALID_REQUEST",
        message: `Session ${key} changed before deletion. Retry.`,
      });
      await expect
        .poll(() => page.locator(".sessions-error[role=alert]").textContent())
        .toContain("changed before deletion. Retry.");
      await gateway.emitGatewayEvent("sessions.changed", {
        ...replacement,
        reason: "update",
        sessionKey: key,
      });
      await replacementLabel.waitFor();
      expect(await page.getByRole("checkbox", { name: `Select session: ${key}` }).isChecked()).toBe(
        false,
      );
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(1);
    });
  });

  it("rejects deleting a same-key replacement after the in-app confirm", async () => {
    const key = "agent:main:research";
    return suite.withPage(desktopOptions, async ({ page }) => {
      // Playwright auto-dismisses native dialogs, which is exactly how a
      // bridge-less WebView behaves. Deleting must not depend on one.
      const nativeDialogs: string[] = [];
      page.on("dialog", (dialog) => {
        nativeDialogs.push(dialog.message());
        void dialog.dismiss();
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.delete": { ok: true, deleted: true },
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
            sessionRow(key, "Research notes", Date.parse("2026-07-01T15:00:00.000Z")),
          ]),
        },
        sessionKey: "agent:main:main",
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await visible(row, 10_000);
      await row.hover();
      await row.click({ button: "right" });
      await menuItem(page, "Advanced").click();
      await menuItem(page.locator("openclaw-session-menu"), "Delete…", false).click();

      const confirmModal = await waitForConfirmModal(page);

      await gateway.deferNext("sessions.delete");
      await roleButton(confirmModal, "Delete").evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error("expected delete confirmation button");
        }
        button.click();
        button.click();
      });

      const request = await gateway.waitForRequest("sessions.delete");
      expect(request).toMatchObject({
        params: { deleteTranscript: true, expectedSessionId: `session:${key}`, key },
      });
      await expectRequestCountStable(gateway, "sessions.delete", 1);
      await gateway.rejectDeferred("sessions.delete", {
        code: "INVALID_REQUEST",
        message: `Session ${key} changed before deletion. Retry.`,
      });
      const visibleError = page.locator("[data-sidebar-session-error]");
      await expect
        .poll(() => visibleError.textContent())
        .toContain("changed before deletion. Retry.");
      expect(await visibleError.textContent()).not.toContain("GatewayRequestError");
      await visible(row);

      expect(nativeDialogs).toEqual([]);
    });
  });

  it("shows the preserved worktree reason before offering forced removal", async () => {
    const key = "agent:main:snapshot-failed";
    return suite.withPage(desktopOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "worktrees.remove"],
        methodResponses: {
          "sessions.delete": {
            ok: true,
            key,
            deleted: true,
            archived: [],
            worktreePreserved: {
              id: "wt-snapshot-failed",
              branch: "openclaw/snapshot-failed",
              path: "/worktrees/snapshot-failed",
              reason: "snapshot-failed",
            },
          },
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
            sessionRow(key, "Snapshot failed", Date.parse("2026-07-01T15:00:00.000Z")),
          ]),
        },
        sessionKey: "agent:main:main",
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await visible(row, 10_000);
      await row.hover();
      await row.click({ button: "right" });
      await menuItem(page, "Advanced").click();
      await menuItem(page.locator("openclaw-session-menu"), "Delete…", false).click();

      const deleteModal = await waitForConfirmModal(page);
      await roleButton(deleteModal, "Delete").click();
      await gateway.waitForRequest("sessions.delete");

      const worktreeModal = await waitForConfirmModal(page);
      await expect
        .poll(() => worktreeModal.textContent())
        .toContain("OpenClaw could not create a safety snapshot");
      await expect.poll(() => worktreeModal.textContent()).toContain("Remove?");

      await roleButton(worktreeModal, "Cancel").click();
      expect(await gateway.getRequests("worktrees.remove")).toHaveLength(0);
    });
  });
});
