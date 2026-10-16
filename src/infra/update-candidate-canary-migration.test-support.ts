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
              child.stderr.write(
                "Preserved configuration needs a migration this Gateway cannot perform\n",
              );
              child.emit("close", 1);
            });
          }
        }
        return child;
      });
      stubHealthyGateway();

      const result = await validateUpdateCandidateCanary({
        ...canaryStateOptions(3_000),
        config: original,
        migrationPolicy,
      });

      expect(result, result.logTail.join("\n")).toMatchObject({ status: expected });
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "candidate-gateway-startup",
          exitCode: expected === "ok" ? 0 : 1,
        }),
      );
      if (migrationPolicy === "startup-only") {
        expect(inputAtBoot?.meta?.lastTouchedVersion).toBeUndefined();
        expect(inputAtBoot?.agents?.list?.map(({ id }) => id)).toEqual(["main"]);
        expect(inputAtBoot?.agents?.entries).toBeUndefined();
        expect(result.steps.some(({ name }) => name === "candidate-doctor")).toBe(false);
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "candidate-recovery", exitCode: 0 }),
        );
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
      stubHealthyGateway();
      const onStep = vi.fn();
      const result = await validateUpdateCandidateCanary({
        ...canaryStateOptions(3_000),
        onStep,
        migrationPolicy,
      });
      expect(result).toMatchObject({
        status: migrationPolicy === "startup-only" ? "error" : "ok",
        phase: "runtime",
      });
      expect(result.candidateSchemaVersions).toBeUndefined();
      expect(result).not.toHaveProperty("checkpointContinuation");
      if (migrationPolicy === "rehearse") {
        expect(result.steps).toEqual([
          expect.objectContaining({
            name: "candidate-recovery",
            exitCode: null,
            stdoutTail: "This version uses the current updater to finish installation",
          }),
        ]);
      } else {
        expect(result.steps).toEqual([
          expect.objectContaining({ name: "candidate-runtime", exitCode: 1 }),
        ]);
      }
      expect(onStep).toHaveBeenCalledWith(result.steps[0]);
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );
}
