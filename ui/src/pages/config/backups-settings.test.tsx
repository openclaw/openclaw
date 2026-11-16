import type { BackupRunRecord, BackupStatusResult } from "@openclaw/gateway-protocol";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { BackupsSettings } from "./backups-settings.tsx";
import {
  clickSettings,
  mountConfigSettings,
  settingsButton as button,
  waitSettingsText as waitText,
} from "./settings-page.test-support.ts";

const offsite = { name: "offsite", provider: "filesystem", encrypted: true } as const;

async function mount(status: () => Promise<BackupStatusResult>) {
  const respond = (method: string): Promise<unknown> =>
    method === "backup.status"
      ? status()
      : method === "storage.locations.probe"
        ? Promise.resolve({ state: "ok", freeBytes: 1024 ** 3 })
        : Promise.resolve(configSnapshot({}, "raw-one"));
  const request = vi.fn((method: string, _params?: unknown, options?: { signal?: AbortSignal }) =>
    options?.signal ? withinTest(respond(method), options.signal) : respond(method),
  );
  const client = { request } as unknown as GatewayBrowserClient;
  const mounted = await mountConfigSettings(client, () => <BackupsSettings />);
  return { ...mounted, request };
}

const calls = (request: ReturnType<typeof vi.fn>, method: string) =>
  request.mock.calls.filter(([called]) => called === method);

it("renders backup outcomes and namespace-owned schedules, probing storage only on request", async () => {
  const now = Date.UTC(2026, 8, 30, 12);
  vi.spyOn(Date, "now").mockReturnValue(now);
  const target = (fields: Partial<BackupRunRecord> = {}, name = "offsite") => {
    const latest: BackupRunRecord = {
      id: "backup",
      createdAt: now,
      archivePath: "/backup",
      kind: "archive",
      status: "ok",
      ...fields,
    };
    return {
      kind: latest.kind,
      target: name,
      namespace: latest.namespace,
      latest,
      latestOk: latest,
    };
  };
  const success = target({
    createdAt: now - 3_600_000,
    location: {
      name: "offsite",
      provider: "filesystem",
      locationId: "fixture-location",
      namespace: "gateway",
      key: "20260930T110000Z-12345678.tar.gz",
      plaintextBytes: 1024,
      storedBytes: 2048,
    },
  }).latest;
  const gitPush = target(
    { createdAt: now - 3_600_000, kind: "git", pushFailed: true },
    "/backups/git",
  );
  const { page, request } = await mount(async () => ({
    targets: [
      {
        kind: "archive",
        target: "offsite",
        namespace: "gateway",
        latest: { ...success, status: "failed", createdAt: now, error: "Disk disconnected." },
        latestOk: success,
      },
      target({ namespace: "host-a", bytes: 4096 }),
      gitPush,
    ],
    schedules: ["gateway", "host-b"].map((namespace) => ({
      id: namespace,
      namespace,
      mode: "offsite" as const,
      target: "offsite",
      enabled: true,
      everyMs: 86_400_000,
      nextRunAtMs: now + 3_600_000,
    })),
    locations: [{ ...offsite, displayTarget: "/Volumes/Archive/openclaw" }],
  }));
  await waitText(page, "Disk disconnected.");
  const rows = [...page.querySelectorAll(".settings-row")].map((row) => row.textContent ?? "");
  expect(rows[0]).toMatch(/Last success: .*ago · 2 KB · Next run:.*\/Volumes\/Archive\/openclaw/);
  expect(rows[0]).toContain("Failed");
  expect(rows[1]).toContain("4 KB");
  expect(rows[1]).not.toContain("Next run:");
  expect(rows[2]).toMatch(/Last local success: .*ago/);
  expect(rows[2]).toContain("Push failed");
  expect(page.textContent).toContain(
    "The local backup succeeded, but couldn’t be pushed to the Git remote.",
  );
  expect(rows[3]).toMatch(/offsite.*No backup recorded yet · Namespace: host-b · Next run:/);

  expect(calls(request, "storage.locations.probe")).toHaveLength(0);
  const probe = createDeferred<{ state: "ok"; freeBytes: number }>();
  request.mockReturnValueOnce(probe.promise);
  const check = clickSettings(page, "Check offsite");
  await waitForSolid(() => expect(check.disabled).toBe(true));
  probe.resolve({ state: "ok", freeBytes: 1024 ** 3 });
  await waitText(page, "1 GB free");
  expect(page.querySelector('[role="status"]')?.textContent).toContain("Available");
  expect(request).toHaveBeenCalledWith(
    "storage.locations.probe",
    { name: "offsite" },
    expect.anything(),
  );
});

it("shows a failed read, recovers on refresh, and needs read access", async () => {
  const failed = createDeferred<BackupStatusResult>();
  let status = () => failed.promise;
  const { page, client, context, publish } = await mount(() => status());
  await waitText(page, "Loading backups…");
  failed.reject(new Error("Backup history unavailable"));
  await waitText(page, "Backup history unavailable", '[role="alert"]');

  status = async () => ({ targets: [], schedules: [], locations: [] });
  clickSettings(page, "Refresh backups", true);
  await waitText(page, "No backups yet. openclaw backup enable --to <location>");

  const hello = context.gateway.snapshot.hello!;
  publish(true, client, { ...hello, auth: { ...hello.auth, scopes: [] } });
  await waitText(page, "You need read access to view backups.");
  expect(page.textContent).not.toContain("No backups yet.");
});

it("discards status and storage checks from the previous connection", async () => {
  const { page, client, publish, request } = await mount(async () => ({
    targets: [],
    schedules: [],
    locations: [offsite],
  }));
  const probe = createDeferred<{ state: "ok"; freeBytes: number }>();
  request.mockReturnValueOnce(probe.promise);
  await waitForSolid(() => expect(button(page, "Check offsite").disabled).toBe(false));
  clickSettings(page, "Check offsite");
  await waitText(page, "Checking…");

  const stale = createDeferred<BackupStatusResult>();
  request.mockReturnValueOnce(stale.promise);
  clickSettings(page, "Refresh backups");
  publish(false, client, null);
  await waitForSolid(() => expect(page.textContent).not.toContain("Checking…"));
  expect(button(page, "Check offsite").disabled).toBe(true);
  probe.resolve({ state: "ok", freeBytes: 1024 ** 3 });
  stale.resolve({ targets: [], schedules: [], locations: [{ ...offsite, name: "old-host" }] });
  await Promise.all([probe.promise, stale.promise]);
  flush();
  expect(page.textContent).not.toContain("old-host");

  publish(true, client);
  await waitForSolid(() => expect(button(page, "Check offsite").disabled).toBe(false));
  expect(page.textContent).not.toContain("1 GB free");
  expect(page.textContent).not.toContain("old-host");
});
