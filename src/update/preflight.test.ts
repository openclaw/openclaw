import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as runtimePaths from "../daemon/runtime-paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { preflight } from "./preflight.js";

afterEach(() => vi.restoreAllMocks());

it.each(["supported", "unsupported"] as const)(
  "checks Bun capabilities (%s), not the target's Node engine",
  async (status) => {
    await withOpenClawTestState({ label: "update-preflight-bun" }, async (state) => {
      vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
        status,
        version: "1.4.5",
        sqliteVersion: status === "supported" ? "3.51.3" : "3.50.0",
        nodeSharedSqlite: false,
        sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      });
      const result = await preflight({
        kind: "package",
        target: {
          kind: "package",
          spec: "openclaw@2026.11.21",
          version: "2026.11.21",
          engines: { node: ">=999" },
        },
        prefix: state.root,
        stateDir: state.stateDir,
        node: path.join(state.root, "bun"),
        statfs: async () => ({ bavail: 2_000_000_000, bsize: 1 }),
      });
      expect(result).toMatchObject(
        status === "supported" ? { ok: true } : { ok: false, reason: "bun-runtime-unsupported" },
      );
      if (!result.ok) {
        expect(result.message).toContain("Bun 1.4.4+ with WAL-reset-safe node:sqlite is required.");
      }
    });
  },
);
