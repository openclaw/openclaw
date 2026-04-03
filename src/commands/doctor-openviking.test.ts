import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const buildPluginRuntimeSummaries = vi.hoisted(() => vi.fn());
const buildPluginRuntimeNotices = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginRuntimeSummaries,
  buildPluginRuntimeNotices,
}));

import { noteOpenVikingHealth } from "./doctor-openviking.js";

describe("noteOpenVikingHealth", () => {
  beforeEach(() => {
    note.mockReset();
    buildPluginRuntimeSummaries.mockReset();
    buildPluginRuntimeNotices.mockReset();
    buildPluginRuntimeSummaries.mockReturnValue([]);
    buildPluginRuntimeNotices.mockReturnValue([]);
  });

  it("does nothing when OpenViking is not the active context engine", async () => {
    await noteOpenVikingHealth({
      plugins: {
        slots: {
          contextEngine: "legacy",
        },
      },
    } as OpenClawConfig);

    expect(note).not.toHaveBeenCalled();
  });

  it("reports a healthy OpenViking runtime snapshot", async () => {
    buildPluginRuntimeSummaries.mockReturnValue([
      {
        pluginId: "openviking",
        health: "ok",
        snapshot: {
          source: "/tmp/workspace/memory/openviking/_status.json",
          summary: ["Results: 4", "Writeback: hybrid"],
          notices: [],
          raw: {},
        },
      },
    ]);

    await noteOpenVikingHealth({
      plugins: {
        slots: {
          contextEngine: "openviking",
          memory: "none",
        },
      },
    } as OpenClawConfig);

    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("OpenViking context engine is active.");
    expect(message).toContain("Results: 4");
    expect(message).toContain("Runtime health: ok");
  });

  it("warns when OpenViking is active but no runtime snapshot exists", async () => {
    await noteOpenVikingHealth({
      plugins: {
        slots: {
          contextEngine: "openviking",
          memory: "none",
        },
      },
    } as OpenClawConfig);

    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("No OpenViking runtime snapshot exists yet.");
    expect(message).toContain("openclaw status");
  });

  it("warns when a separate memory slot is still enabled", async () => {
    buildPluginRuntimeSummaries.mockReturnValue([
      {
        pluginId: "openviking",
        health: "ok",
        snapshot: {
          source: "/tmp/workspace/memory/openviking/_status.json",
          summary: [],
          notices: [],
          raw: {},
        },
      },
    ]);

    await noteOpenVikingHealth({
      plugins: {
        slots: {
          contextEngine: "openviking",
          memory: "memory-core",
        },
      },
    } as OpenClawConfig);

    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain('Memory slot is still set to "memory-core"');
    expect(message).toContain("plugins.slots.memory");
  });

  it("includes runtime notices in the doctor note", async () => {
    buildPluginRuntimeSummaries.mockReturnValue([
      {
        pluginId: "openviking",
        health: "error",
        snapshot: {
          source: "/tmp/workspace/memory/openviking/_status.json",
          summary: ["Retrieval: failed"],
          notices: [{ severity: "error", message: "retrieval failed: timeout" }],
          raw: {},
        },
      },
    ]);
    buildPluginRuntimeNotices.mockReturnValue([
      {
        pluginId: "openviking",
        source: "/tmp/workspace/memory/openviking/_status.json",
        severity: "error",
        message: "retrieval failed: timeout",
      },
    ]);

    await noteOpenVikingHealth({
      plugins: {
        slots: {
          contextEngine: "openviking",
          memory: "none",
        },
      },
    } as OpenClawConfig);

    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("Runtime notices:");
    expect(message).toContain("[error] retrieval failed: timeout");
  });
});
