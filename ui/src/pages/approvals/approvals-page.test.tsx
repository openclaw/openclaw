/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalHistoryResult } from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type {
  ExecApprovalGrantsListResult,
  ExecApprovalStandingGrant,
} from "../../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ApprovalsPage } from "./approvals-page.tsx";

const historyText = (page: HTMLElement) =>
  page.querySelector(".approval-history-table")?.textContent;
const grantsText = (page: HTMLElement) => page.querySelector(".standing-grants-table")?.textContent;
const grantButton = (page: HTMLElement) =>
  page.querySelector<HTMLButtonElement>(".standing-grants-table button");
const waitForHistory = (page: HTMLElement, text: string) =>
  waitForSolid(() => expect(historyText(page)).toContain(text));
const waitForGrants = (page: HTMLElement, text: string) =>
  waitForSolid(() => expect(grantsText(page)).toContain(text));

function terminal(id: string, resolvedAtMs: number): ApprovalHistoryResult["items"][number] {
  return {
    id,
    status: "denied",
    presentation: {
      kind: "exec",
      commandText: `echo ${id}`,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    urlPath: `/approve/${id}`,
    createdAtMs: resolvedAtMs - 1_000,
    expiresAtMs: resolvedAtMs + 60_000,
    resolvedAtMs,
    decision: "deny",
    reason: "user",
    source: { agentId: "main", sessionKey: "agent:main:test" },
    resolver: { kind: "device", id: "reviewer-device" },
  };
}

function createPage(
  request: (method: string, params?: unknown) => unknown,
  auth?: { role: string; scopes?: string[]; recoveryScope?: string },
) {
  const client = { request } as GatewayBrowserClient;
  const initialGateway = createApplicationGateway({
    phase: "connected",
    client,
    ...(auth ? { hello: { auth } } : {}),
  } as ApplicationGatewaySnapshot);
  let currentGateway = initialGateway;
  const context = {
    basePath: "",
    gateway: currentGateway.gateway,
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const { container: page } = mountSolid(() => <ApprovalsPage />, { wrapper: provider.wrapper });
  flush();
  return {
    page,
    replaceGatewaySource() {
      currentGateway = createApplicationGateway(currentGateway.gateway.snapshot);
      provider.setContext({ ...context, gateway: currentGateway.gateway });
      flush();
    },
    emitGatewayEvent(event: string, payload: unknown) {
      initialGateway.publishEvent({ event, payload, type: "event" } as GatewayEventFrame);
    },
    updateGateway(next: Partial<ApplicationGatewaySnapshot>) {
      currentGateway.publish({ ...currentGateway.gateway.snapshot, ...next });
    },
  };
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function stubGrants(
  history: (method: string, params?: unknown) => unknown,
): GatewayBrowserClient["request"] {
  // Keep grant reads out of the history mock's ordered queue and call counts.
  return ((method: string, params?: unknown) =>
    method === "exec.approval.grants.list"
      ? Promise.resolve({ grants: [] })
      : (history(method, params) as Promise<unknown>)) as GatewayBrowserClient["request"];
}

function mockLedger(grants: () => unknown, other: (method: string, params?: unknown) => unknown) {
  return vi.fn((method: string, params?: unknown) =>
    method === "exec.approval.grants.list" ? grants() : other(method, params),
  );
}

function operatorHello(scopes: string[]): ApplicationGatewaySnapshot["hello"] {
  return { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"];
}

function standingGrant(name: string): ExecApprovalStandingGrant {
  return {
    grantId: "grant-1",
    mintedByApprovalId: "approval-1",
    agentId: "main",
    cronJobId: "job-1",
    cronJobName: name,
    command: "id -un",
    cwd: null,
    createdAtMs: 1_000,
    expiresAtMs: null,
    revokedAtMs: null,
    revokedBy: null,
    lastUsedAtMs: null,
    useCount: 3,
  };
}

describe("ApprovalsPage", () => {
  it("keeps history and grants through a blip without allowing offline actions", async () => {
    const refreshedHistory = createDeferred<ApprovalHistoryResult>();
    let historyReads = 0;
    const request = mockLedger(
      () => Promise.resolve({ grants: [standingGrant("Retained automation")] }),
      () =>
        ++historyReads === 1
          ? Promise.resolve({ items: [terminal("retained", 2_000)], nextCursor: "next" })
          : refreshedHistory.promise,
    );
    const { page, updateGateway } = createPage(request, {
      role: "operator",
      scopes: ["operator.approvals"],
    });
    await waitForGrants(page, "Retained automation");

    updateGateway({ phase: "reconnecting", hello: null });
    flush();
    expect(historyText(page)).toContain("echo retained");
    expect(grantsText(page)).toContain("Retained automation");
    expect(grantButton(page)?.disabled).toBe(true);
    expect(page.querySelector<HTMLButtonElement>(".data-table-pagination button")?.disabled).toBe(
      true,
    );

    updateGateway({
      phase: "connected",
      hello: operatorHello(["operator.approvals"]),
    });
    flush();
    expect(historyText(page)).toContain("echo retained");
    refreshedHistory.resolve({ items: [terminal("fresh", 3_000)] });
    await waitForHistory(page, "echo fresh");

    updateGateway({
      client: { request } as unknown as GatewayBrowserClient,
      phase: "reconnecting",
    });
    flush();
    expect(page.textContent).not.toContain("echo fresh");
    expect(page.textContent).not.toContain("Retained automation");
  });

  it("does not claim an empty history when the load failed", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const { page } = createPage(stubGrants(request));

    await waitForSolid(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("boom"),
    );

    const body = page.querySelector(".approval-history-table tbody")?.textContent ?? "";
    expect(body).not.toContain("No resolved approvals");
  });

  it("refreshes the newest history after an approval resolves during pagination", async () => {
    const olderPage = createDeferred<ApprovalHistoryResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [terminal("first", 2_000)], nextCursor: "next" })
      .mockReturnValueOnce(olderPage.promise)
      .mockResolvedValueOnce({ items: [terminal("newest", 3_000), terminal("first", 2_000)] });
    const { page, emitGatewayEvent } = createPage(stubGrants(request));

    await waitForHistory(page, "echo first");
    const loadMore = [...page.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Load more"),
    );
    loadMore?.click();
    flush();
    expect(request).toHaveBeenCalledTimes(2);

    emitGatewayEvent("exec.approval.resolved", { id: "newest", decision: "deny" });
    expect(request).toHaveBeenCalledTimes(2);

    olderPage.resolve({ items: [terminal("older", 1_000)] });
    await waitForHistory(page, "echo newest");

    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("approval.history", { limit: 50 });
  });

  it("does not request or render approval history for a read-only operator", async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const { page } = createPage(stubGrants(request), {
      role: "operator",
      scopes: ["operator.read"],
    });

    flush();

    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector(".approval-history-table")).toBeNull();
    expect(page.querySelector('[role="status"]')?.textContent).toContain("operator.approvals");
  });

  it("loads approval history for a legacy operator", async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const { page } = createPage(stubGrants(request), { role: "operator" });

    await waitForSolid(() => expect(page.querySelector(".approval-history-table")).not.toBeNull());

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("approval.history", { limit: 50 });
  });

  it("discards stale history when approval access changes on the same gateway", async () => {
    const staleHistory = createDeferred<ApprovalHistoryResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(staleHistory.promise)
      .mockResolvedValueOnce({ items: [terminal("current", 2_000)] });
    const { page, emitGatewayEvent, updateGateway } = createPage(stubGrants(request), {
      role: "operator",
      scopes: ["operator.approvals"],
    });

    flush();
    expect(request).toHaveBeenCalledOnce();

    updateGateway({
      hello: operatorHello(["operator.read"]),
    });
    flush();
    emitGatewayEvent("exec.approval.resolved", { id: "inaccessible", decision: "deny" });
    flush();
    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector(".approval-history-table")).toBeNull();

    updateGateway({
      hello: operatorHello(["operator.admin"]),
    });
    await waitForHistory(page, "echo current");
    expect(request).toHaveBeenCalledTimes(2);

    staleHistory.resolve({ items: [terminal("stale", 1_000)] });
    await staleHistory.promise;
    flush();
    expect(historyText(page)).toContain("echo current");
    expect(historyText(page)).not.toContain("echo stale");
  });

  it.each(["client", "source", "account", "recovery scope"] as const)(
    "clears standing grants while a replacement %s loads its ledger",
    async (replacement) => {
      const nextGrants = createDeferred<ExecApprovalGrantsListResult>();
      let replaced = false;
      const request = mockLedger(
        () =>
          replaced
            ? nextGrants.promise
            : Promise.resolve({ grants: [standingGrant("Old Gateway automation")] }),
        () => Promise.resolve({ items: [] }),
      );
      const { page, updateGateway, replaceGatewaySource } = createPage(request, {
        role: "operator",
        recoveryScope: "scope-first",
      });
      updateGateway({ selfUser: { id: "first" } });
      await waitForGrants(page, "Old Gateway automation");

      replaced = true;
      if (replacement === "source") {
        replaceGatewaySource();
      } else if (replacement === "account") {
        updateGateway({ selfUser: { id: "second" } });
      } else if (replacement === "recovery scope") {
        updateGateway({
          hello: {
            auth: { role: "operator", recoveryScope: "scope-second" },
          } as ApplicationGatewaySnapshot["hello"],
        });
      } else {
        updateGateway({ client: { request } as unknown as GatewayBrowserClient });
      }
      flush();
      expect(grantsText(page)).not.toContain("Old Gateway automation");
      expect(grantButton(page)).toBeNull();

      nextGrants.resolve({ grants: [standingGrant("Current Gateway automation")] });
      await waitForGrants(page, "Current Gateway automation");
    },
  );

  it.each([
    { replacement: "source", outcome: "resolve" },
    { replacement: "client", outcome: "reject" },
  ] as const)(
    "retires a previous $replacement revoke that later $outcome without settling the current revoke",
    async ({ replacement, outcome }) => {
      const oldRevoke = createDeferred<{ outcome: string }>();
      const currentRevoke = createDeferred<{ outcome: string }>();
      let replaced = false;
      const request = mockLedger(
        () =>
          Promise.resolve({
            grants: [
              standingGrant(replaced ? "Current Gateway automation" : "Old Gateway automation"),
            ],
          }),
        (method) => {
          if (method === "exec.approval.grants.revoke") {
            return replaced ? currentRevoke.promise : oldRevoke.promise;
          }
          return Promise.resolve({ items: [] });
        },
      );
      const { page, updateGateway, replaceGatewaySource } = createPage(request);
      await waitForSolid(() => expect(grantButton(page)).not.toBeNull());
      grantButton(page)!.click();
      flush();

      replaced = true;
      if (replacement === "source") {
        replaceGatewaySource();
      } else {
        updateGateway({ client: { request } as unknown as GatewayBrowserClient });
      }
      await waitForGrants(page, "Current Gateway automation");
      const currentButton = grantButton(page)!;
      expect(currentButton.disabled).toBe(false);
      currentButton.click();
      flush();
      expect(currentButton.disabled).toBe(true);
      expect(currentButton.textContent).toContain("Revoking");

      if (outcome === "resolve") {
        oldRevoke.resolve({ outcome: "revoked" });
      } else {
        oldRevoke.reject(new Error("Old Gateway revoke failed"));
      }
      await Promise.allSettled([oldRevoke.promise]);
      flush();
      expect(grantsText(page)).toContain("Until revoked");
      expect(page.textContent).not.toContain("Old Gateway revoke failed");
      expect(currentButton.disabled).toBe(true);
      expect(currentButton.textContent).toContain("Revoking");

      currentRevoke.resolve({ outcome: "revoked" });
      await waitForGrants(page, "Revoked");
      expect(grantButton(page)).toBeNull();
    },
  );

  it("renders the standing-grant ledger and revokes through the gateway", async () => {
    const history = vi.fn().mockResolvedValue({ items: [] });
    const pendingRefresh = createDeferred<ExecApprovalGrantsListResult>();
    let grantReads = 0;
    const grant = standingGrant("Nightly backup");
    const request = mockLedger(
      () => (++grantReads === 1 ? Promise.resolve({ grants: [grant] }) : pendingRefresh.promise),
      (method, params) => {
        if (method === "exec.approval.grants.revoke") {
          return Promise.resolve({ outcome: "revoked", params });
        }
        return history(method, params) as Promise<unknown>;
      },
    );
    const { page, emitGatewayEvent } = createPage(request);

    await waitForGrants(page, "Nightly backup");

    const ledger = page.querySelector(".standing-grants-table");
    expect(ledger?.textContent).toContain("id -un");
    expect(ledger?.textContent).toContain("Until revoked");

    emitGatewayEvent("exec.approval.resolved", { id: "another-approval", decision: "deny" });
    await waitForSolid(() => expect(grantReads).toBe(2));

    const revoke = [...page.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Revoke"),
    );
    expect(revoke?.getAttribute("aria-label")).toBe("Revoke: Nightly backup — id -un");
    expect(ledger?.querySelector("th:last-child")?.textContent?.trim()).toBe("Revoke");
    revoke?.click();
    await waitForGrants(page, "Revoked");

    expect(request).toHaveBeenCalledWith("exec.approval.grants.revoke", { grantId: "grant-1" });

    pendingRefresh.resolve({ grants: [grant] });
    await pendingRefresh.promise;
    flush();
    expect(grantsText(page)).toContain("Revoked");
    expect(grantButton(page)).toBeNull();
  });
});
