import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryHealth } from "../plugins/memory-provider-types.js";
import {
  getActiveMemoryProviderCore,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";
import { collectMemorySearchHealthFindings } from "./doctor-memory-search.js";

/** Builds note-text assertions bound to the shared terminal note mock. */
export function createDoctorNoteAssertions(note: ReturnType<typeof vi.fn>): {
  firstNoteMessage: () => string;
  expectFirstNoteContains: (...values: string[]) => void;
  expectFirstNoteExcludes: (...values: string[]) => void;
} {
  const firstMessage = () => String(note.mock.calls[0]?.[0] ?? "");
  return {
    firstNoteMessage: firstMessage,
    expectFirstNoteContains(...values) {
      const message = firstMessage();
      for (const value of values) {
        expect(message).toContain(value);
      }
    },
    expectFirstNoteExcludes(...values) {
      const message = firstMessage();
      for (const value of values) {
        expect(message).not.toContain(value);
      }
    },
  };
}

type ProviderRuntimeDoctorTestParams = {
  cfg: OpenClawConfig;
  stubMemorySearchConfig: (provider: string, overrides?: Record<string, unknown>) => void;
  noteMemorySearchHealth: typeof import("./doctor-memory-search.js").noteMemorySearchHealth;
  expectFirstNoteContains: (...values: string[]) => void;
};

// Keep terminal notes and structured findings on the same provider fixture.
function configureProviderHealth(params: ProviderRuntimeDoctorTestParams, health: MemoryHealth) {
  const close = vi.fn().mockResolvedValue(undefined);
  params.stubMemorySearchConfig("none");
  vi.mocked(resolveActiveMemoryBackendConfig).mockReturnValue({
    backend: "provider-runtime",
    providerId: "records",
  });
  vi.mocked(getActiveMemoryProviderCore).mockResolvedValue({
    providerId: "records",
    provider: {
      capabilities: {
        sources: ["memory"],
        pagination: false,
        candidates: [],
        projectFilter: false,
      },
      search: vi.fn().mockResolvedValue({ hits: [] }),
      get: vi.fn().mockResolvedValue({ status: "not_found" }),
      health: vi.fn().mockResolvedValue(health),
      close,
    },
  });
  return close;
}

// Exercise the health-check collector used by Doctor's structured output.
function collectProviderFindings(cfg: OpenClawConfig) {
  return collectMemorySearchHealthFindings({
    mode: "lint",
    cfg,
    env: { OPENCLAW_STATE_DIR: "/isolated-memory-state" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
}

/** Registers provider-runtime health coverage against the shared Doctor mocks. */
export function registerProviderRuntimeDoctorTest(params: ProviderRuntimeDoctorTestParams): void {
  it("reports native provider health as an informational doctor note", async () => {
    const close = configureProviderHealth(params, { status: "ready", message: "connected" });

    await params.noteMemorySearchHealth(params.cfg, { includeWorkspaceMemoryHealth: false });

    params.expectFirstNoteContains(
      "Not applicable: records uses the provider runtime",
      "Provider health: ready (connected)",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["ready", "degraded", "unavailable"] as const)(
    "collects structured native provider health findings for %s",
    async (status) => {
      const close = configureProviderHealth(params, { status, message: "provider health detail" });

      const findings = await collectProviderFindings(params.cfg);

      if (status === "ready") {
        expect(findings).toEqual([]);
      } else {
        expect(findings).toEqual([
          expect.objectContaining({
            checkId: "core/doctor/memory-search",
            severity: "warning",
            path: "plugins.slots.memory",
          }),
        ]);
        const diagnostic = `${findings[0]?.message} ${findings[0]?.fixHint}`;
        expect(diagnostic).toContain("records");
        expect(diagnostic).toContain(status);
        expect(diagnostic).toContain("provider health detail");
      }
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("collects a native provider acquisition failure as an unavailable warning", async () => {
    const close = configureProviderHealth(params, { status: "ready" });
    vi.mocked(getActiveMemoryProviderCore).mockRejectedValue(new Error("connection failed"));

    const findings = await collectProviderFindings(params.cfg);

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/memory-search",
        severity: "warning",
        path: "plugins.slots.memory",
      }),
    ]);
    const diagnostic = `${findings[0]?.message} ${findings[0]?.fixHint}`;
    expect(diagnostic).toContain("records");
    expect(diagnostic).toContain("unavailable");
    expect(diagnostic).toContain("connection failed");
    expect(close).not.toHaveBeenCalled();
  });
}
