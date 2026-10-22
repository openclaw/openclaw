import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SessionStorageSettings } from "./session-storage.tsx";
import {
  clickSettings,
  mountConfigSettings,
  settingsButton as button,
  waitSettingsText as waitText,
} from "./settings-page.test-support.ts";

type Maintenance = Partial<SessionsStorageStatusResult["maintenance"]>;
function inventory(count: number, maintenance: Maintenance = {}): SessionsStorageStatusResult {
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
      ...maintenance,
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
  const reply =
    (method: string, read: () => Promise<unknown>) =>
    (called: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
      const response = called === method ? read() : respond(called);
      return options?.signal ? withinTest(response, options.signal) : response;
    };
  const client = { request } as unknown as GatewayBrowserClient;
  const mounted = await mountConfigSettings(client, () => <SessionStorageSettings />);
  await waitText(mounted.page, "7 uncompressed");
  return { ...mounted, request, respond, reply };
}
function click(page: HTMLElement, label: string) {
  clickSettings(page, label, true);
}
async function expectIdle(request: ReturnType<typeof vi.fn>) {
  const calls = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls).toHaveLength(calls);
}
function draft(page: HTMLElement, value: string) {
  const input = page.querySelector<HTMLInputElement>('input[type="number"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}
it.each([
  ["status", "reconnect"],
  ["run", "client"],
])("rejects a delayed %s response after the Gateway %s changes", async (kind, change) => {
  const warnings = vi.spyOn(console, "warn");
  const { page, context, request, client, reply, publish } = await mount();
  const method = `sessions.storage.${kind}`;
  const previous = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementation(reply(method, () => previous.promise));
  click(page, kind === "status" ? "Refresh" : "Run now");
  await waitForSolid(() =>
    expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(
      kind === "status" ? 2 : 1,
    ),
  );
  expect(page.textContent).toContain("7 uncompressed");
  const currentRequest = vi.fn(reply("sessions.storage.status", async () => inventory(42)));
  if (change === "client") {
    publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
  } else {
    request.mockImplementation(currentRequest);
    const hello = context.gateway.snapshot.hello;
    publish(false, client, hello);
    publish(true, client, hello);
  }
  await waitText(page, "42 uncompressed");
  previous.resolve(inventory(700, { archivedTranscripts: 693 }));
  await previous.promise;
  flush();
  expect(page.textContent).toContain("42 uncompressed");
  expect(page.textContent).not.toContain("700 uncompressed");
  if (kind === "run") {
    expect(page.textContent).not.toContain("Batch completed");
    expect(button(page, "Run now").disabled).toBe(false);
  }
  expect(
    warnings.mock.calls.filter(([message]) =>
      String(message).includes("UNTRACKED_READ_AFTER_AWAIT"),
    ),
  ).toEqual([]);
});

it("shows submission progress and clears a rejected run before retrying", async () => {
  const { page, request, reply } = await mount();
  const runControl = button(page, "Run now");
  const ageControl = page.querySelector<HTMLInputElement>('input[type="number"]')!;
  const failed = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementation(reply("sessions.storage.run", () => failed.promise));
  click(page, "Run now");
  await waitForSolid(() => expect(button(page, "Running").disabled).toBe(true));
  expect(page.querySelector<HTMLInputElement>('input[type="number"]')!.disabled).toBe(true);

  failed.reject(new Error("Maintenance unavailable"));
  await waitText(page, "Maintenance unavailable", '[role="alert"]');
  expect(button(page, "Run now")).toBe(runControl);
  expect(page.querySelector('input[type="number"]')).toBe(ageControl);
  expect(runControl.disabled).toBe(false);

  const retry = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementation(reply("sessions.storage.run", () => retry.promise));
  click(page, "Run now");
  await waitForSolid(() => expect(button(page, "Running").disabled).toBe(true));
  expect(page.textContent).not.toContain("Maintenance unavailable");
  retry.resolve(inventory(7));
  await waitText(page, "Batch completed. 0 transcripts archived.");
  expect(button(page, "Run now")).toBe(runControl);
  expect(page.querySelector('input[type="number"]')).toBe(ageControl);
  expect(runControl.disabled).toBe(false);
});

it("does not hold a replacement submission behind a retired request", async () => {
  const { page, request, reply, publish } = await mount();
  const retired = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementation(reply("sessions.storage.run", () => retired.promise));
  click(page, "Run now");
  const current = createDeferred<SessionsStorageStatusResult>();
  const currentRequest = vi.fn(reply("sessions.storage.run", () => current.promise));
  publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
  await waitForSolid(() => expect(button(page, "Run now").disabled).toBe(false));
  click(page, "Run now");
  await waitForSolid(() => expect(button(page, "Running").disabled).toBe(true));
  current.resolve(inventory(7));
  await waitText(page, "Batch completed. 0 transcripts archived.");
  expect(button(page, "Run now").disabled).toBe(false);

  retired.resolve(inventory(7, { archivedTranscripts: 693 }));
  await retired.promise;
  flush();
  expect(button(page, "Run now").disabled).toBe(false);
  expect(page.textContent).not.toContain("693");
});

it("keeps a days draft and inventory through reconnect and retires them on client replacement", async () => {
  const { page, runtimeConfig, request, reply, publish, client } = await mount();
  const input = draft(page, "14");
  request.mockImplementation(reply("sessions.storage.status", async () => inventory(42)));
  click(page, "Refresh");
  await waitText(page, "42 uncompressed");
  expect(input.value).toBe("14");
  expect(runtimeConfig.state.configFormDirty).toBe(false);

  const retired = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementationOnce(() => retired.promise);
  click(page, "Refresh");
  publish(false, client, null);
  retired.resolve(inventory(700));
  await retired.promise;
  flush();
  expect(input).toMatchObject({ value: "14", disabled: true });
  expect(page.textContent).toContain("42 uncompressed");
  const reconnect = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementation(reply("sessions.storage.status", () => reconnect.promise));
  publish(true, client);
  flush();
  expect(input.value).toBe("14");
  expect(page.textContent).toContain("42 uncompressed");
  reconnect.resolve(inventory(21));
  await waitText(page, "21 uncompressed");
  expect(input.value).toBe("14");

  draft(page, "");
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(runtimeConfig.state.configFormDirty).toBe(false);
  expect(request.mock.calls.some(([method]) => method === "config.set")).toBe(false);

  const replacement = createDeferred<SessionsStorageStatusResult>();
  const replacementRequest = vi.fn(reply("sessions.storage.status", () => replacement.promise));
  publish(true, { request: replacementRequest } as unknown as GatewayBrowserClient);
  try {
    await waitForSolid(() => {
      expect(
        replacementRequest.mock.calls.some(([method]) => method === "sessions.storage.status"),
      ).toBe(true);
      expect(input.value).toBe("30");
      expect(page.textContent).not.toContain("21 uncompressed");
    });
  } finally {
    replacement.resolve(inventory(7));
  }
  await waitText(page, "7 uncompressed");
  expect(input.value).toBe("30");
});

it("keeps the focused days draft and Refresh control through a failed inventory read and retry", async () => {
  const { page, request, respond } = await mount();
  const input = draft(page, "14");
  const failure = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementationOnce(() => failure.promise);
  const refresh = button(page, "Refresh");
  input.focus();
  click(page, "Refresh");
  failure.reject(new Error("Inventory unavailable"));
  await waitText(page, "Inventory unavailable");
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("14");
  expect(page.textContent).not.toContain("7 uncompressed");

  request.mockImplementation(respond);
  click(page, "Refresh");
  await waitText(page, "7 uncompressed");
  expect(page.textContent).not.toContain("Inventory unavailable");
  expect(button(page, "Refresh")).toBe(refresh);
  expect(input.value).toBe("14");
});

it("retires the days draft and inventory when a fresh hello removes access", async () => {
  const { page, context, client, publish } = await mount();
  const input = draft(page, "14");
  const hello = context.gateway.snapshot.hello!;
  publish(true, client, { ...hello, auth: { ...hello.auth, scopes: [] } });
  flush();
  expect(input).toMatchObject({ value: "30", disabled: true });
  expect(page.textContent).not.toContain("7 uncompressed");
});

async function startBackgroundRun() {
  const mounted = await mount();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const running = inventory(7, { running: true, lastStartedAt: 100 });
  const nextStatus = vi.fn<() => Promise<SessionsStorageStatusResult>>().mockResolvedValue(running);
  const readStatus = mounted.reply("sessions.storage.status", nextStatus);
  mounted.request.mockImplementation((method) =>
    method === "sessions.storage.run" ? Promise.resolve(running) : readStatus(method),
  );
  click(mounted.page, "Run now");
  await waitText(mounted.page, "Background batch started.");
  await waitText(mounted.page, "Running", ".settings-status");
  return { ...mounted, running, nextStatus };
}

it("follows run completion after reconnect", async () => {
  const { page, request, nextStatus, client, publish } = await startBackgroundRun();
  expect(page.textContent).not.toContain("Batch completed");
  publish(false, client, null);
  flush();
  expect(page.textContent).toContain("Background batch started.");
  nextStatus.mockResolvedValue(
    inventory(5, {
      lastCompletedAt: 200,
      archivedTranscripts: 2,
      externalizedTranscripts: 3,
    }),
  );
  publish(true, client);
  await waitText(page, "Batch completed. 2 transcripts archived.");
  expect(page.textContent).toContain("3 compressed archives moved from the database to files.");
  await expectIdle(request);
});

it("stops polling after a status failure and resumes only after an explicit refresh", async () => {
  const { page, request, running, nextStatus } = await startBackgroundRun();
  nextStatus.mockRejectedValue(new Error("Worker status unavailable"));
  await vi.advanceTimersByTimeAsync(2_000);
  await waitText(page, "Worker status unavailable");
  expect(page.textContent).toContain("Refresh to check the current maintenance state.");
  await expectIdle(request);
  nextStatus.mockResolvedValue(running);
  click(page, "Refresh");
  await waitText(page, "Running", ".settings-status");
  nextStatus.mockResolvedValue(
    inventory(7, {
      lastCompletedAt: 200,
      lastError: "Archive publication failed",
    }),
  );
  await vi.advanceTimersByTimeAsync(2_000);
  await waitText(page, "Archive publication failed");
  expect(page.textContent).not.toContain("Batch completed");
  await expectIdle(request);
});

it.each(["detach", "disconnect", "replace"])("retires background polling on %s", async (change) => {
  const { page, request, respond, publish, unmount } = await startBackgroundRun();
  if (change === "detach") {
    unmount();
  } else if (change === "disconnect") {
    publish(false);
  } else {
    publish(true, { request: vi.fn(respond) } as unknown as GatewayBrowserClient);
  }
  flush();
  await expectIdle(request);
  if (change === "replace") {
    expect(page.textContent).not.toContain("Background batch started.");
  } else if (change === "disconnect") {
    expect(page.textContent).toContain("Background batch started.");
  }
});
