/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ApprovalGetResult,
  ApprovalResolveResult,
  PendingApprovalSnapshot,
  ExecApprovalPresentation,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "./approval-page.tsx";

type TestApprovalPage = SolidBridgeElement<{ approvalId: string }>;

const execPresentation: ExecApprovalPresentation = {
  kind: "exec",
  commandText: "printf safe",
  allowedDecisions: ["allow-once", "deny"],
};

function pendingApproval(
  overrides: Partial<PendingApprovalSnapshot> = {},
): PendingApprovalSnapshot {
  return {
    id: "exec:approval-1",
    urlPath: "/approve/exec%3Aapproval-1",
    status: "pending",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    presentation: { ...execPresentation },
    ...overrides,
  };
}

function terminal(status: "allowed" | "expired" = "allowed"): ApprovalResolveResult["approval"] {
  const base = { ...pendingApproval(), resolvedAtMs: 2_000 };
  return status === "allowed"
    ? { ...base, status, decision: "allow-once", reason: "user" }
    : { ...base, status, reason: "timeout" };
}

function watcherApproval(operation: "add" | "update"): PendingApprovalSnapshot {
  return pendingApproval({
    presentation: {
      ...execPresentation,
      streamProposal: { jobId: "watcher/alpha", name: "Build monitor", operation },
    },
  });
}

const get = (approval: ApprovalGetResult["approval"] = pendingApproval()): ApprovalGetResult => ({
  approval,
});
const allowed = (): ApprovalResolveResult => ({ applied: true, approval: terminal() });
const lookupRequest = (approval: ApprovalGetResult["approval"] = pendingApproval()) =>
  vi.fn(async () => get(approval));
function decisionRequest(
  result: ApprovalResolveResult | Promise<ApprovalResolveResult>,
  pending = pendingApproval(),
) {
  return vi.fn<GatewayRequestHandler>((method) =>
    Promise.resolve(method === "approval.get" ? get(pending) : result),
  );
}

async function queuedPage(
  fallback: GatewayRequestHandler = async () => get(),
  resolution?: ApprovalResolveResult,
) {
  const lookup = Promise.withResolvers<ApprovalGetResult>();
  const request = vi.fn(fallback).mockResolvedValueOnce(get()).mockReturnValueOnce(lookup.promise);
  if (resolution) {
    request.mockResolvedValueOnce(resolution);
  }
  const page = await createPage(request, operator());
  refresh();
  refresh();
  return { ...page, request, lookup };
}

async function createPage(
  request: GatewayRequestHandler,
  hello?: ApplicationGatewaySnapshot["hello"],
) {
  const { gateway, publish } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: { request } as GatewayBrowserClient,
      phase: "connected",
      hello:
        hello === undefined
          ? ({ auth: { role: "operator" } } as ApplicationGatewaySnapshot["hello"])
          : hello,
      assistantAgentId: "main",
      sessionKey: "main",
    }),
  );
  const source = {
    update(patch: Partial<ApplicationGatewaySnapshot>) {
      publish({ ...gateway.snapshot, ...patch });
    },
  };

  const page = document.createElement("openclaw-approval-page") as TestApprovalPage;
  const provider = createApplicationContextProvider({
    basePath: "",
    gateway,
  } as unknown as ApplicationContext);
  page.approvalId = "exec:approval-1";
  provider.append(page);
  document.body.append(provider);
  await settle(page);
  return { page, source };
}

function operator(scopes = ["operator.approvals"]): ApplicationGatewaySnapshot["hello"] {
  return { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"];
}

function decision(page: TestApprovalPage, value = "allow-once") {
  return page.querySelector<HTMLButtonElement>(`[data-decision="${value}"]`)!;
}

function text(page: TestApprovalPage, selector: string) {
  return page.querySelector(selector)?.textContent;
}

function busy(page: TestApprovalPage) {
  return page.querySelector(".approval-page__card")?.getAttribute("aria-busy");
}

function refresh(visibility = visibilityState) {
  visibilityState = visibility;
  document.dispatchEvent(new Event("visibilitychange"));
}

function expectRedacted(page: TestApprovalPage, state: string) {
  expect(page.querySelector(".approval-page")?.getAttribute("data-state")).toBe(state);
  expect(page.querySelector(".approval-page__preview")).toBeNull();
  expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
}

function expectReviewOnly(page: TestApprovalPage) {
  expect(text(page, ".approval-page__preview")).toBe("printf safe");
  expect(decision(page).disabled).toBe(true);
}

async function settle(page: TestApprovalPage, rounds = 1) {
  for (let round = 0; round < rounds; round++) {
    await Promise.resolve();
    await Promise.resolve();
    await page.updateComplete;
  }
}

let visibilityState: DocumentVisibilityState;

beforeEach(async () => {
  await i18n.setLocale("en");
  visibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

it.each(["success", "failure"] as const)(
  "shows a held decision once and settles its %s feedback",
  async (outcome) => {
    const held = Promise.withResolvers<ApprovalResolveResult>();
    const request = decisionRequest(held.promise);
    const { page } = await createPage(request);
    decision(page).click();
    decision(page, "deny").click();
    expect(request.mock.calls.filter(([method]) => method === "approval.resolve")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("approval.resolve", {
      id: "exec:approval-1",
      kind: "exec",
      decision: "allow-once",
    });
    await waitForSolid(() => {
      expect(decision(page).disabled).toBe(true);
      expect(decision(page).textContent).toContain("Recording");
      expect(busy(page)).toBe("true");
    });
    if (outcome === "success") {
      held.resolve(allowed());
      await waitForSolid(() => expect(text(page, "h1")).toBe("Approved here"));
    } else {
      held.reject(new Error("Synthetic resolution failure"));
      await waitForSolid(() => {
        expect(page.querySelector('[role="alert"]')).not.toBeNull();
        expect(decision(page).textContent).not.toContain("Recording");
      });
    }
    expect(busy(page)).toBe("false");
  },
);

it.each(["id", "connection", "grant"] as const)(
  "retires a held decision when its %s changes",
  async (change) => {
    const held = Promise.withResolvers<ApprovalResolveResult>();
    let current = pendingApproval();
    const request = vi.fn((method: string): Promise<unknown> =>
      method === "approval.get" ? Promise.resolve(get(current)) : held.promise,
    );
    const { page, source } = await createPage(request);
    decision(page).click();
    await waitForSolid(() => expect(decision(page).textContent).toContain("Recording"));
    if (change === "grant") {
      source.update({ hello: null });
    } else {
      current = pendingApproval({
        id: change === "id" ? "exec:approval-2" : current.id,
        presentation: { ...execPresentation, commandText: "printf replacement" },
      });
    }
    if (change === "id") {
      page.approvalId = current.id;
    } else if (change === "connection") {
      source.update({ phase: "stopped" });
      source.update({ phase: "connected" });
    }
    const preview = change === "grant" ? "printf safe" : "printf replacement";
    await waitForSolid(() => {
      expect(text(page, ".approval-page__preview")).toBe(preview);
      expect(decision(page).disabled).toBe(change === "grant");
      expect(decision(page).textContent).not.toContain("Recording");
    });
    if (change === "grant") {
      expectReviewOnly(page);
    }
    held.resolve(allowed());
    await settle(page);
    expect(text(page, ".approval-page__preview")).toBe(preview);
    expect(decision(page).disabled).toBe(change === "grant");
    expect(text(page, "h1")).not.toBe("Approved here");
    expect(request.mock.calls.filter(([method]) => method === "approval.resolve")).toHaveLength(1);
  },
);

it.each(["exec", "plugin"] as const)(
  "shows the %s approval scope before a decision",
  async (kind) => {
    const presentation: PendingApprovalSnapshot["presentation"] =
      kind === "exec"
        ? {
            ...execPresentation,
            scope: {
              kind: "standing-grant",
              automation: "Nightly workspace check",
              command: "printf safe",
              expiresInDays: 14,
            },
          }
        : {
            kind,
            title: "Plugin command",
            description: "Run a command",
            severity: "warning",
            allowedDecisions: ["allow-once", "deny"],
            scope: {
              kind: "payment",
              amount: "12.34",
              currency: "USD",
              target: "Synthetic vendor",
            },
          };
    const { page } = await createPage(lookupRequest(pendingApproval({ presentation })));
    expect(page.textContent).toContain(
      kind === "exec"
        ? 'Always allow runs this exact command for "Nightly workspace check" without asking, for 14 days (revocable)'
        : "Pays 12.34 USD to Synthetic vendor",
    );
  },
);

it.each([
  ["add", "allow", "Start watching"],
  ["update", "allow", "Save watcher change"],
  ["update", "deny", "It did not stop or change the existing watcher"],
  ["add", "timeout", "This proposal did not create a watcher"],
  [null, "timeout", "No decision arrived before the deadline"],
] as const)(
  "presents %s / %s without overstating execution",
  async (operation, outcome, expected) => {
    const pending = operation ? watcherApproval(operation) : pendingApproval();
    const resolved: ApprovalGetResult["approval"] =
      outcome === "deny"
        ? { ...pending, status: "denied", decision: "deny", reason: "user", resolvedAtMs: 2_000 }
        : {
            ...terminal(outcome === "allow" ? "allowed" : "expired"),
            presentation: pending.presentation,
          };
    const request =
      outcome === "deny"
        ? lookupRequest(resolved)
        : decisionRequest({ applied: outcome === "allow", approval: resolved }, pending);
    const { page } = await createPage(request);
    await settle(page);
    if (outcome === "allow") {
      expect(text(page, "h1")).toContain("Build monitor");
      expect(page.textContent).toContain("after you leave this chat, until stopped");
      expect(page.textContent).toContain("restart automatically");
      expect(decision(page, "deny").textContent?.trim()).toBe("Cancel");
      expect(decision(page).textContent?.trim()).toBe(expected);
    }
    if (outcome !== "deny") {
      decision(page).click();
      await waitForSolid(() =>
        expect(text(page, "h1")).toBe(outcome === "allow" ? "Approved here" : "Expired"),
      );
    }
    if (outcome === "allow") {
      expect(text(page, ".approval-page__heading p")).toContain(
        "Approval alone does not confirm that the change was saved or the watcher started",
      );
    } else {
      expect(page.textContent).toContain(expected);
      expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
      if (outcome === "timeout") {
        expect(page.textContent).not.toContain("Another surface or an earlier attempt");
      }
    }
  },
);

it.each(["anonymous", "ungranted", "revoked", "disconnected"])(
  "enforces approval visibility and decision authority for %s",
  async (access) => {
    const request = lookupRequest();
    const { page, source } = await createPage(
      request,
      access === "anonymous" ? null : operator(access === "ungranted" ? [] : undefined),
    );
    if (access !== "ungranted") {
      const action = decision(page);
      expect(text(page, ".approval-page__preview")).toBe("printf safe");
      if (access !== "anonymous") {
        source.update(
          access === "disconnected"
            ? { phase: "stopped", client: null, hello: operator(["operator.read"]) }
            : { hello: operator(["operator.read"]) },
        );
      }
      action.click();
      await settle(page);
    }
    if (access === "anonymous") {
      expectReviewOnly(page);
    } else {
      expectRedacted(page, access === "disconnected" ? "connection-error" : "missing-scope");
      expect(page.textContent).not.toContain("printf safe");
      if (access === "ungranted") {
        expect(text(page, '[role="alert"]')).toContain("operator.approvals");
      }
    }
    expect(request.mock.calls).toEqual(
      access === "ungranted" ? [] : [["approval.get", { id: "exec:approval-1" }]],
    );
  },
);

it.each(["access", "connection"])("rejects stale lookups after %s is restored", async (change) => {
  const stale = Promise.withResolvers<ApprovalGetResult>();
  const request = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValueOnce(get(terminal()));
  const { page, source } = await createPage(request, operator());
  if (change === "access") {
    source.update({ hello: operator(["operator.read"]) });
    source.update({ hello: operator() });
  } else {
    source.update({ phase: "reconnecting" });
    source.update({ phase: "connected" });
  }
  await waitForSolid(() => expect(text(page, "h1")).toBe("Approved"));
  stale.resolve(get());
  await settle(page);
  expect(request).toHaveBeenCalledTimes(2);
  expect(text(page, "h1")).toBe("Approved");
  expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
});

it.each([false, true])("polls only while visible (failed=%s)", async (failed) => {
  vi.useFakeTimers();
  const request = lookupRequest();
  if (failed) {
    request.mockResolvedValueOnce(get()).mockRejectedValue(new Error("Gateway failure"));
  }
  const { page } = await createPage(request);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000);
  await settle(page);
  expect(request).toHaveBeenCalledTimes(2);
  const alert = page.querySelector(".approval-page__callout");
  if (failed) {
    expect(alert).not.toBeNull();
    expect(decision(page).disabled).toBe(true);
  }
  await vi.advanceTimersByTimeAsync(2_000);
  await settle(page);
  expect(request).toHaveBeenCalledTimes(3);
  expect(page.querySelector(".approval-page__callout")).toBe(alert);
  refresh("hidden");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(request).toHaveBeenCalledTimes(3);
  refresh("visible");
  await settle(page);
  expect(request).toHaveBeenCalledTimes(4);
});

it.each(["id", "client"])(
  "retires old actions and queued lookups when the %s changes",
  async (change) => {
    const { page, source, request, lookup } = await queuedPage(async (method, params) => {
      if (method !== "approval.get" || !isRecord(params) || typeof params.id !== "string") {
        throw new Error("Expected an approval ID");
      }
      return get(pendingApproval({ id: params.id }));
    });
    const oldDecision = decision(page);
    if (change === "id") {
      page.approvalId = "exec:approval-2";
      page.approvalId = "exec:approval-3";
      oldDecision.click();
    } else {
      source.update({ client: createTestGatewayClient(request) });
    }
    await settle(page);
    expect(request.mock.calls).toEqual([
      ["approval.get", { id: "exec:approval-1" }],
      ["approval.get", { id: "exec:approval-1" }],
      ["approval.get", { id: change === "id" ? "exec:approval-3" : "exec:approval-1" }],
    ]);
    lookup.resolve(get());
    await settle(page, 2);
    expect(request).toHaveBeenCalledTimes(3);
    expect(text(page, ".approval-page__preview")).toBe("printf safe");
    expect(decision(page).disabled).toBe(false);
  },
);

it.each(["hidden", "expired", "failed"])(
  "runs the queued follow-up only when a poll would run after %s",
  async (outcome) => {
    const { page, request, lookup } = await queuedPage();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      refresh("hidden");
      refresh("visible");
    }
    expect(request).toHaveBeenCalledTimes(2);
    if (outcome === "failed") {
      lookup.reject(new Error("temporary Gateway failure"));
    } else {
      if (outcome === "hidden") {
        refresh("hidden");
      }
      lookup.resolve(get(outcome === "expired" ? terminal("expired") : pendingApproval()));
    }
    await settle(page, 2);
    expect(request).toHaveBeenCalledTimes(outcome === "failed" ? 3 : 2);
  },
);

it("formats approval times in the selected locale", async () => {
  await i18n.setLocale("de");
  const approval = pendingApproval();
  const { page } = await createPage(lookupRequest(approval));
  expect(text(page, "time")?.trim()).toBe(
    new Date(approval.expiresAtMs).toLocaleString("de", {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
});

it.each(["applied", "reconciled"] as const)(
  "retires a queued lookup when a decision is %s",
  async (outcome) => {
    const { page, request, lookup } = await queuedPage(
      async () => get(terminal("expired")),
      allowed(),
    );
    decision(page, outcome === "applied" ? "allow-once" : "deny").click();
    const title = outcome === "applied" ? "Approved here" : "Expired";
    await waitForSolid(() => expect(text(page, "h1")).toBe(title));
    const calls = outcome === "applied" ? 3 : 4;
    lookup.resolve(get());
    await settle(page, 2);
    expect(request).toHaveBeenCalledTimes(calls);
    expect(text(page, "h1")).toBe(title);
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  },
);

it.each([false, true])(
  "shows Retry progress and preserves context (join background=%s)",
  async (join) => {
    const lookup = Promise.withResolvers<ApprovalGetResult>();
    const followUp = Promise.withResolvers<ApprovalGetResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(get())
      .mockRejectedValueOnce(new Error("temporary Gateway failure"))
      .mockReturnValueOnce(lookup.promise)
      .mockReturnValueOnce(followUp.promise);
    const { page } = await createPage(request);
    refresh();
    await waitForSolid(() => expect(page.querySelector(".approval-page__callout")).not.toBeNull());
    if (join) {
      refresh();
      await settle(page);
    }
    const retry = page.querySelector<HTMLButtonElement>(".approval-page__callout button")!;
    expect(retry.disabled).toBe(false);
    expect(busy(page)).toBe("false");
    retry.click();
    await waitForSolid(() => {
      expect(retry.disabled).toBe(true);
      expect(busy(page)).toBe("true");
      expect(text(page, ".approval-page__preview")).toBe("printf safe");
      expect(decision(page).disabled).toBe(true);
    });
    expect(request).toHaveBeenCalledTimes(3);
    lookup.resolve(get());
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(join ? 4 : 3);
      expect(busy(page)).toBe("false");
      expect(page.querySelector(".approval-page__callout")).toBeNull();
    });
    followUp.resolve(get());
    await settle(page);
    expect(request).toHaveBeenCalledTimes(join ? 4 : 3);
    expect(decision(page).disabled).toBe(false);
  },
);
