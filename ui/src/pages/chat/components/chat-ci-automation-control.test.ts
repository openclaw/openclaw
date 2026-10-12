/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { CronJob } from "../../../api/types.ts";
import {
  ciAutomationJobSpec,
  type CiAutomationOption,
} from "../../../lib/session-pr-automation-spec.ts";
import {
  createGatewayHarness,
  flushSync,
} from "../../../lib/session-pull-requests.test-support.ts";
import type { ChatCiAutomationElement } from "./chat-ci-automation-control.ts";
import { renderChatPullRequests } from "./chat-pull-requests.ts";

const sessionKey = "agent:main:dashboard:ci-test";
const pr = {
  owner: "example",
  repo: "project",
  number: 42,
  branch: "feature",
  title: "CI controls",
  state: "open" as const,
  url: "https://github.com/example/project/pull/42",
};
function inventory(jobs: CronJob[]) {
  return {
    jobs,
    total: jobs.length,
    limit: 200,
    offset: 0,
    hasMore: false,
    nextOffset: null,
    snapshotRevision: "inventory",
  };
}
const roots = new Set<HTMLElement>();
afterEach(() => {
  for (const root of roots) {
    render(nothing, root);
    root.remove();
  }
  roots.clear();
  vi.restoreAllMocks();
});

function job(sessionId: string, option: CiAutomationOption = "autoFix"): CronJob {
  return {
    ...ciAutomationJobSpec({ ...pr, agentId: "main", sessionKey, sessionId }, option),
    id: option + "-" + sessionId,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
    configRevision: "v1",
  };
}

async function setup() {
  const harness = createGatewayHarness();
  const client = new GatewayBrowserClient({ url: "ws://example.test" });
  const request = vi
    .spyOn(client, "request")
    .mockImplementation(async (method) =>
      method === "cron.status" ? { enabled: true, triggersEnabled: true, jobs: 0 } : inventory([]),
    );
  harness.setSnapshot({
    ...harness.gateway.snapshot,
    client,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
    },
  });
  const root = document.createElement("div");
  document.body.append(root);
  roots.add(root);
  const paint = async (sessionId: string) => {
    render(
      renderChatPullRequests({
        pullRequests: [pr],
        gateway: harness.gateway,
        sessionKey,
        sessionId,
        status: "ready",
        onDismiss: () => {},
      }),
      root,
    );
    const element = root.querySelector<ChatCiAutomationElement>("openclaw-chat-ci-automation")!;
    await element.updateComplete;
    return element;
  };
  const element = await paint("first");
  const open = async () => {
    const disclosure = root.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    await element.updateComplete;
  };
  const settle = async () => {
    await flushSync();
    await element.updateComplete;
    await flushSync();
    await element.updateComplete;
  };
  const checkbox = (option: CiAutomationOption = "autoFix") =>
    root.querySelector<HTMLInputElement>(`input[name="${option}"]`)!;
  return { ...harness, root, client, request, element, paint, open, settle, checkbox };
}

describe("CI automation popup scope", () => {
  it("keeps independent toggles responsive and reconciles silently after saving", async () => {
    const h = await setup();
    const pending = createDeferred<CronJob>();
    let stored = job("first");
    h.request.mockImplementation(async (method) =>
      method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: 1 }
        : method === "cron.update"
          ? pending.promise
          : inventory([stored]),
    );
    await h.open();
    await h.settle();
    const before = h.root.textContent;
    h.checkbox().click();
    expect(h.checkbox().checked).toBe(false);
    await h.element.updateComplete;
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox().closest("fieldset")?.disabled).toBe(false);
    expect(h.root.querySelector<HTMLInputElement>('input[name="autoMerge"]')!.disabled).toBe(false);
    expect(h.root.textContent).toBe(before);
    expect(h.root.querySelector('a[href*="?job="]')).toBeNull();
    stored = { ...stored, enabled: false, configRevision: "v2" };
    pending.resolve(stored);
    await h.settle();
    expect(h.checkbox().checked).toBe(false);
    expect(h.root.textContent).toBe(before);
  });

  it("keeps concurrent intents across stale inventory and out-of-order acknowledgements", async () => {
    const h = await setup();
    const staleRead = createDeferred<ReturnType<typeof inventory>>();
    const fixWrite = createDeferred<CronJob>();
    const mergeWrite = createDeferred<{ job: CronJob }>();
    const fix = job("first");
    const merge = job("first", "autoMerge");
    let stored = [fix];
    h.request.mockImplementation(async (method) => {
      if (method === "cron.status") {
        return { enabled: true, triggersEnabled: true, jobs: stored.length };
      }
      if (method === "cron.update") {
        return fixWrite.promise;
      }
      if (method === "cron.add") {
        return mergeWrite.promise;
      }
      return inventory(stored);
    });
    await h.open();
    await h.settle();
    h.request.mockImplementationOnce(() => staleRead.promise);
    h.emit({}, "cron");
    await h.element.updateComplete;
    h.checkbox().click();
    h.checkbox("autoMerge").click();
    await h.element.updateComplete;
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox("autoMerge").checked).toBe(true);
    expect(h.checkbox("autoArchive").disabled).toBe(false);
    staleRead.resolve(inventory([job("first")]));
    await h.settle();
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox("autoMerge").checked).toBe(true);
    stored.push(merge);
    mergeWrite.resolve({ job: merge });
    h.emit({}, "cron");
    h.emit({}, "cron");
    await h.settle();
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox().disabled).toBe(true);
    expect(h.checkbox("autoMerge").disabled).toBe(false);
    expect(h.request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(2);
    const disabledFix = { ...fix, enabled: false, configRevision: "v2" };
    stored = [disabledFix, merge];
    fixWrite.resolve(disabledFix);
    await h.settle();
    expect(h.request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(3);
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox("autoMerge").checked).toBe(true);
    expect(h.checkbox().disabled).toBe(false);
  });

  it("retains a lost-ack error through sibling completion and reconciles without replay", async () => {
    const h = await setup();
    const fixWrite = createDeferred<{ job: CronJob }>();
    const mergeWrite = createDeferred<{ job: CronJob }>();
    h.request.mockImplementation(async (method, params) => {
      if (method === "cron.status") {
        return { enabled: true, triggersEnabled: true, jobs: 0 };
      }
      if (method === "cron.add") {
        return (params as { declarationKey: string }).declarationKey.endsWith(":autoFix")
          ? fixWrite.promise
          : mergeWrite.promise;
      }
      return inventory([]);
    });
    await h.open();
    await h.settle();
    h.checkbox().click();
    h.checkbox("autoMerge").click();
    h.emit({}, "cron");
    fixWrite.reject(new Error("Lost acknowledgement"));
    await h.settle();
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox("autoMerge").checked).toBe(true);
    h.request.mockImplementation(async (method) =>
      method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: 2 }
        : inventory([job("first"), job("first", "autoMerge")]),
    );
    mergeWrite.resolve({ job: job("first", "autoMerge") });
    await h.settle();
    expect(h.root.textContent).toContain("Lost acknowledgement");
    expect(h.checkbox().checked).toBe(true);
    expect(h.checkbox("autoMerge").checked).toBe(true);
    h.root.querySelector<HTMLButtonElement>(".chat-ci__automation-retry")!.click();
    await h.settle();
    expect(h.root.querySelector('[role="alert"]')).toBeNull();
    expect(h.request.mock.calls.filter(([method]) => method === "cron.add")).toHaveLength(2);
  });

  it.each(["identity", "connection", "read scope"])(
    "settles a visible popup without %s until its prerequisites change",
    async (missing) => {
      const h = await setup();
      if (missing === "identity") {
        await h.paint("");
      } else if (missing === "connection") {
        h.setSnapshot({ ...h.gateway.snapshot, phase: "reconnecting" });
      } else {
        h.setSnapshot({
          ...h.gateway.snapshot,
          hello: {
            type: "hello-ok",
            protocol: 1,
            auth: { role: "operator", scopes: ["operator.sessions.read"] },
          },
        });
      }
      await h.element.updateComplete;
      await h.open();
      await h.element.updateComplete;
      expect(await h.element.updateComplete).toBe(true);
      expect(h.request).not.toHaveBeenCalled();
      expect(h.checkbox().closest("fieldset")?.disabled).toBe(true);
    },
  );

  it("ignores a delayed inventory after session replacement", async () => {
    const h = await setup();
    const oldRead = createDeferred<ReturnType<typeof inventory>>();
    h.request.mockImplementation(async (method) =>
      method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: 1 }
        : oldRead.promise,
    );
    await h.open();
    expect(h.request.mock.calls.some(([method]) => method === "cron.list")).toBe(true);
    await h.paint("replacement");
    h.request.mockImplementation(async (method) =>
      method === "cron.status" ? { enabled: true, triggersEnabled: true, jobs: 0 } : inventory([]),
    );
    await h.open();
    await h.settle();
    oldRead.resolve(inventory([job("first")]));
    await h.settle();
    expect(h.checkbox().checked).toBe(false);
    expect(h.checkbox().closest("fieldset")?.disabled).toBe(false);
    expect(h.root.textContent).not.toContain("fix-first");
  });

  it.each(["session", "auth", "gateway"])(
    "ignores a rejected write after %s replacement",
    async (change) => {
      const h = await setup();
      const pending = createDeferred<{ job: CronJob }>();
      h.request.mockImplementation(async (method) =>
        method === "cron.status"
          ? { enabled: true, triggersEnabled: true, jobs: 0 }
          : method === "cron.add"
            ? pending.promise
            : inventory([]),
      );
      await h.open();
      await h.settle();
      h.checkbox().click();
      await h.element.updateComplete;
      if (change === "session") {
        await h.paint("replacement");
        await h.open();
      } else if (change === "auth") {
        h.setSnapshot({
          ...h.gateway.snapshot,
          hello: {
            type: "hello-ok",
            protocol: 1,
            auth: { role: "operator", scopes: ["operator.read"] },
          },
        });
      } else {
        h.element.gateway = createGatewayHarness().gateway;
      }
      await h.settle();
      pending.reject(new Error("Old context failure"));
      await h.settle();
      expect(h.root.textContent).not.toContain("Old context failure");
      expect(h.checkbox().checked).toBe(false);
      expect(h.request.mock.calls.filter(([method]) => method === "cron.add")).toHaveLength(1);
    },
  );

  it("does not apply an old write to a reconnected Gateway or replay it", async () => {
    const h = await setup();
    const pending = createDeferred<CronJob>();
    h.request.mockImplementation(async (method) =>
      method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: 1 }
        : method === "cron.update"
          ? pending.promise
          : inventory([job("first")]),
    );
    await h.open();
    await h.settle();
    expect(h.checkbox().checked).toBe(true);
    h.checkbox().checked = false;
    h.checkbox().dispatchEvent(new Event("change"));
    await h.element.updateComplete;
    expect(h.request.mock.calls.filter(([method]) => method === "cron.update")).toHaveLength(1);
    h.setSnapshot({ ...h.gateway.snapshot, phase: "reconnecting" });
    await h.element.updateComplete;
    h.request.mockImplementation(async (method) =>
      method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: 1 }
        : inventory([job("first")]),
    );
    h.setSnapshot({ ...h.gateway.snapshot, phase: "connected" });
    await h.settle();
    pending.resolve({ ...job("first"), enabled: false });
    await h.settle();
    expect(h.checkbox().checked).toBe(true);
    expect(h.request.mock.calls.filter(([method]) => method === "cron.update")).toHaveLength(1);
  });
});
