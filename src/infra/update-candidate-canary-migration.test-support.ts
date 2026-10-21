import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { type FakeChild, stubHealthyGateway } from "./update-candidate-canary.test-support.js";

export function registerCanaryMigrationPolicyTests({
  mocks,
  canaryStateOptions,
  getChildEnv,
}: {
  mocks: { spawn: Mock; snapshot: Mock };
  canaryStateOptions: (timeoutMs?: number) => Parameters<typeof validateUpdateCandidateCanary>[0];
  getChildEnv: () => NodeJS.ProcessEnv;
}) {
  const step = (name: string, exitCode: number | null) =>
    expect.objectContaining({ name, exitCode });
  const validate = (params: Partial<Parameters<typeof validateUpdateCandidateCanary>[0]>) => {
    stubHealthyGateway();
    return validateUpdateCandidateCanary({ ...canaryStateOptions(3_000), ...params });
  };
  it.each([
    { migrationPolicy: "rehearse", startupMigration: false, expected: "ok" },
    { migrationPolicy: "startup-only", startupMigration: false, expected: "error" },
    { migrationPolicy: "startup-only", startupMigration: true, expected: "ok" },
  ] as const)(
    "proves preserved-input startup ($migrationPolicy, startup migration=$startupMigration)",
    async ({ migrationPolicy, startupMigration, expected }) => {
      const original: OpenClawConfigWithLegacyRoster = { agents: { list: [{ id: "main" }] } };
      let inputAtBoot: OpenClawConfigWithLegacyRoster | undefined;
      const spawnNormally = mocks.spawn.getMockImplementation()!;
      mocks.spawn.mockImplementation((command, args: string[], options) => {
        const configPath = options.env.OPENCLAW_CONFIG_PATH;
        const migrate = () => {
          const config: OpenClawConfigWithLegacyRoster = JSON.parse(
            readFileSync(configPath, "utf8"),
          );
          config.meta = { ...config.meta, lastTouchedVersion: "2026.9.1" };
          writeFileSync(configPath, JSON.stringify(config));
        };
        if (args.includes("doctor") && args.includes("--fix")) {
          migrate();
        }
        const child: FakeChild = spawnNormally(command, args, options);
        if (args.includes("gateway")) {
          inputAtBoot = JSON.parse(readFileSync(configPath, "utf8"));
          if (startupMigration) {
            migrate();
          } else if (!inputAtBoot?.meta?.lastTouchedVersion) {
            queueMicrotask(() => {
              child.stderr.write("Configuration migration required\n");
              child.emit("close", 1);
            });
          }
        }
        return child;
      });
      const result = await validate({ config: original, migrationPolicy });

      expect(result, result.logTail.join("\n")).toMatchObject({ status: expected });
      expect(result.steps).toContainEqual(
        step("candidate-gateway-startup", expected === "ok" ? 0 : 1),
      );
      if (migrationPolicy === "startup-only") {
        expect(inputAtBoot?.meta?.lastTouchedVersion).toBeUndefined();
        expect(inputAtBoot?.agents?.list?.map(({ id }) => id)).toEqual(["main"]);
        expect(inputAtBoot?.agents?.entries).toBeUndefined();
        expect(result.steps.some(({ name }) => name === "candidate-doctor")).toBe(false);
        expect(result.steps).toContainEqual(step("candidate-recovery", 0));
      } else {
        expect(inputAtBoot?.meta?.lastTouchedVersion).toBe("2026.9.1");
      }
      expect(original).toEqual({ agents: { list: [{ id: "main" }] } });
      await expect(fs.access(getChildEnv().OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it.each(["rehearse", "startup-only"] as const)(
    "handles unavailable startup validation under %s policy",
    async (migrationPolicy) => {
      await fs.rm(
        path.join(canaryStateOptions().root, "dist", "infra", "update-migrated-finalize.worker.js"),
      );
      const onStep = vi.fn();
      const result = await validate({ onStep, migrationPolicy });
      const rehearsing = migrationPolicy === "rehearse";
      expect(result).toMatchObject({
        status: rehearsing ? "ok" : "error",
        phase: "runtime",
      });
      expect(result.candidateSchemaVersions).toBeUndefined();
      expect(result).not.toHaveProperty("checkpointContinuation");
      expect(result.steps).toEqual([
        step(rehearsing ? "candidate-recovery" : "candidate-runtime", rehearsing ? null : 1),
      ]);
      if (rehearsing) {
        expect(result.steps[0]?.stdoutTail).toBe(
          "This version uses the current updater to finish installation",
        );
      }
      expect(onStep).toHaveBeenCalledWith(result.steps[0]);
      expect([mocks.snapshot.mock.calls, mocks.spawn.mock.calls]).toEqual([[], []]);
    },
  );
}
