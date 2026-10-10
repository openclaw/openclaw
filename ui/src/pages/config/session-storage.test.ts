import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import "./session-storage.ts";

type StorageElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
};
const configs: RuntimeConfigCapability[] = [];
function inventory(count: number): SessionsStorageStatusResult {
  return {
    agents: [
      {
        agentId: "main",
        storePath: "/synthetic/agent.sqlite",
        hotTranscripts: count,
        coldTranscripts: 0,
        databaseBytes: 4096,
        walBytes: 0,
        archiveBytes: 0,
        embeddedArchiveBytes: 0,
      },
    ],
    maintenance: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null,
      archivedTranscripts: 0,
      externalizedTranscripts: 0,
    },
  };
}
async function mount() {
  const config = { session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } } };
  const respond = async (method: string): Promise<unknown> =>
    method === "sessions.storage.status"
      ? inventory(7)
      : {
          config,
          hash: "raw-one",
          configRevisionHash: "revision-one",
          appliedConfigHash: "revision-one",
          valid: true,
          issues: [],
          raw: JSON.stringify(config),
        };
  const request = vi.fn(respond);
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway, publish } = createGatewayHarness(client);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  configs.push(runtimeConfig);
  await runtimeConfig.ensureLoaded();
  const page = document.createElement("openclaw-session-storage-settings") as StorageElement;
  page.context = { gateway, runtimeConfig } as unknown as ApplicationContext;
  document.body.append(page);
  await vi.waitFor(() => expect(page.textContent).toContain("7 uncompressed"));
  return { page, request, client, respond, publish };
}
function click(page: HTMLElement, label: string) {
  const button = [...page.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  )!;
  expect(button.disabled).toBe(false);
  button.click();
}
afterEach(() => {
  document.body.replaceChildren();
  for (const config of configs.splice(0)) {
    config.dispose();
  }
  vi.restoreAllMocks();
});

it.each(["client", "handshake"])(
  "rejects a delayed inventory after the Gateway %s changes",
  async (change) => {
    const { page, request, client, respond, publish } = await mount();
    const previous = createDeferred<SessionsStorageStatusResult>();
    request.mockImplementation((method) =>
      method === "sessions.storage.status" ? previous.promise : respond(method),
    );
    click(page, "Refresh");
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.storage.status"),
      ).toHaveLength(2),
    );
    expect(page.textContent).toContain("7 uncompressed");
    const currentRequest = vi.fn((method: string) =>
      method === "sessions.storage.status" ? Promise.resolve(inventory(42)) : respond(method),
    );
    if (change === "client") {
      publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
    } else {
      request.mockImplementation(currentRequest);
      publish(true, client);
    }
    await vi.waitFor(() => expect(page.textContent).toContain("42 uncompressed"));
    previous.resolve(inventory(700));
    await previous.promise;
    await page.updateComplete;
    expect(page.textContent).toContain("42 uncompressed");
    expect(page.textContent).not.toContain("700 uncompressed");
  },
);

it("does not publish an old Gateway's completed run after a new connection", async () => {
  const { page, request, respond, publish } = await mount();
  const previous = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementation((method) =>
    method === "sessions.storage.run" ? previous.promise : respond(method),
  );
  click(page, "Run now");
  await vi.waitFor(() =>
    expect(request.mock.calls.some(([method]) => method === "sessions.storage.run")).toBe(true),
  );
  const currentRequest = vi.fn((method: string) =>
    method === "sessions.storage.status" ? Promise.resolve(inventory(42)) : respond(method),
  );
  publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
  await vi.waitFor(() => expect(page.textContent).toContain("42 uncompressed"));
  previous.resolve({
    ...inventory(700),
    maintenance: { ...inventory(700).maintenance, archivedTranscripts: 693 },
  });
  await previous.promise;
  await page.updateComplete;
  expect(page.textContent).not.toContain("Batch completed");
  expect(page.textContent).not.toContain("700 uncompressed");
  expect(
    [...page.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Run now")
      ?.disabled,
  ).toBe(false);
});

it("keeps a days draft through inventory refresh and retires it on connection replacement", async () => {
  const { page, request, respond, publish } = await mount();
  const input = page.querySelector<HTMLInputElement>('input[type="number"]')!;
  input.value = "14";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  request.mockImplementation((method) =>
    method === "sessions.storage.status" ? Promise.resolve(inventory(42)) : respond(method),
  );
  click(page, "Refresh");
  await vi.waitFor(() => expect(page.textContent).toContain("42 uncompressed"));
  expect(input.value).toBe("14");
  expect(page.context.runtimeConfig.state.configFormDirty).toBe(false);

  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(page.context.runtimeConfig.state.configFormDirty).toBe(false);
  expect(request.mock.calls.some(([method]) => method === "config.set")).toBe(false);

  const currentRequest = vi.fn(respond);
  publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
  await vi.waitFor(() => expect(page.textContent).toContain("7 uncompressed"));
  expect(input.value).toBe("30");
});

async function startBackgroundRun() {
  const mounted = await mount();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const running = {
    ...inventory(7),
    maintenance: { ...inventory(7).maintenance, running: true, lastStartedAt: 100 },
  };
  let nextStatus: () => Promise<SessionsStorageStatusResult> = async () => running;
  mounted.request.mockImplementation((method) =>
    method === "sessions.storage.run"
      ? Promise.resolve(running)
      : method === "sessions.storage.status"
        ? nextStatus()
        : mounted.respond(method),
  );
  click(mounted.page, "Run now");
  await vi.waitFor(() => expect(mounted.page.textContent).toContain("Background batch started."));
  await vi.waitFor(() =>
    expect(mounted.page.querySelector(".settings-status")?.textContent).toContain("Running"),
  );
  return {
    ...mounted,
    running,
    setStatus: (read: typeof nextStatus) => {
      nextStatus = read;
    },
  };
}

it("tracks an accepted job until completion and stops polling while idle", async () => {
  const { page, request, setStatus } = await startBackgroundRun();
  const reads = () =>
    request.mock.calls.filter(([method]) => method === "sessions.storage.status").length;
  const acceptedReads = reads();
  expect(page.textContent).not.toContain("Batch completed");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(reads()).toBe(acceptedReads + 1);
  setStatus(async () => ({
    ...inventory(5),
    maintenance: {
      ...inventory(5).maintenance,
      lastCompletedAt: 200,
      archivedTranscripts: 2,
      externalizedTranscripts: 3,
    },
  }));
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.waitFor(() =>
    expect(page.textContent).toContain("Batch completed. 2 transcripts archived."),
  );
  expect(page.textContent).toContain("3 compressed archives moved from the database to files.");
  const finishedReads = reads();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reads()).toBe(finishedReads);
});

it("stops polling after a status failure and resumes only after an explicit refresh", async () => {
  const { page, request, running, setStatus } = await startBackgroundRun();
  setStatus(async () => {
    throw new Error("Worker status unavailable");
  });
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.waitFor(() => expect(page.textContent).toContain("Worker status unavailable"));
  expect(page.textContent).toContain("Refresh to check the current maintenance state.");
  const failedReads = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls).toHaveLength(failedReads);
  setStatus(async () => running);
  click(page, "Refresh");
  await vi.waitFor(() =>
    expect(page.querySelector(".settings-status")?.textContent).toContain("Running"),
  );
  setStatus(async () => ({
    ...inventory(7),
    maintenance: {
      ...inventory(7).maintenance,
      lastCompletedAt: 200,
      lastError: "Archive publication failed",
    },
  }));
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.waitFor(() => expect(page.textContent).toContain("Archive publication failed"));
  expect(page.textContent).not.toContain("Batch completed");
  const terminalReads = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls).toHaveLength(terminalReads);
});

it.each(["detach", "disconnect", "replace"])("retires background polling on %s", async (change) => {
  const { page, request, respond, publish } = await startBackgroundRun();
  if (change === "detach") {
    page.remove();
  } else if (change === "disconnect") {
    publish(false);
  } else {
    publish(true, { request: vi.fn(respond) } as unknown as GatewayBrowserClient);
  }
  await page.updateComplete;
  const previousCalls = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls).toHaveLength(previousCalls);
  if (change !== "detach") {
    expect(page.textContent).not.toContain("Background batch started.");
  }
});
