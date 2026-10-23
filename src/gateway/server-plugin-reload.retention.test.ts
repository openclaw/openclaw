import { afterEach, expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { withPluginRetentionOwner } from "../plugins/plugin-retention-diagnostics.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createPluginReloadCleanup,
  PluginAdmittedWorkTimeoutError,
} from "./server-plugin-reload-cleanup.js";

afterEach(() => vi.useRealTimers());

it.each(["release", "timeout"] as const)(
  "observes queued references through %s without revealing owner IDs or releasing work",
  async (outcome) => {
    vi.useFakeTimers();
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "fixture", status: "loaded" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const release = withPluginRetentionOwner(
      { sessionKey: "private-session", runId: "private-run" },
      () => instance.retainWork("prepared-generation-lease"),
    );
    const referenceId = instance.retentionSnapshot().references[0]!.referenceId;
    const info = vi.fn();
    const signal = new AbortController().signal;
    const cleanup = createPluginReloadCleanup({
      previousRegistry: registry,
      changedPluginIds: new Set([record.id]),
      port: 0,
      pluginWorkspaceDir: undefined,
      getCron: () => {
        throw new Error("cron must not be called by observation");
      },
      abortSignal: signal,
      log: { ...createSubsystemLogger("test/retention"), info },
      recordCleanup: vi.fn(),
      recordWarning: vi.fn(),
      retainRetirement: vi.fn(),
    });
    const status = vi.fn();
    const observation = cleanup.drainRetainedWork(new Set([record.id]), signal, status, {
      includeConsumers: true,
      includeCalls: true,
    });
    const observed = observation.catch((error: unknown) => error);
    expect(info.mock.calls.map(([line]) => line).join("\n")).toContain(referenceId);
    expect(info.mock.calls.map(([line]) => line).join("\n")).toContain(
      "a turn awaiting its own retained work cannot drain",
    );
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/private-session|private-run/);
    expect(instance.retainedWorkCount).toBe(1);
    expect(instance.disposing).toBe(false);
    if (outcome === "timeout") {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await observed).toBeInstanceOf(PluginAdmittedWorkTimeoutError);
      expect(JSON.stringify(info.mock.calls)).toContain("Plugin retained references (timeout)");
      expect(JSON.stringify(info.mock.calls)).not.toMatch(/private-session|private-run/);
      expect(instance.retainedWorkCount).toBe(1);
      expect(instance.acceptingCalls).toBe(true);
      expect(instance.retentionSnapshot().references[0]!.referenceId).toBe(referenceId);
    }
    release();
    if (outcome === "release") {
      await expect(observation).resolves.toBeUndefined();
    }
    await observed;
    expect(instance.retentionSnapshot().total).toBe(0);
  },
);
