/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { CronJob } from "../../../api/types.ts";
import { ciAutomationJobSpec } from "../../../lib/session-pr-automation-spec.ts";
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

function job(sessionId: string): CronJob {
  return {
    ...ciAutomationJobSpec({ ...pr, agentId: "main", sessionKey, sessionId }, "autoFix"),
    id: "fix-" + sessionId,
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
  const checkbox = () => root.querySelector<HTMLInputElement>('input[name="autoFix"]')!;
  return { ...harness, root, client, request, element, paint, open, settle, checkbox };
}

describe("CI automation popup scope", () => {
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
