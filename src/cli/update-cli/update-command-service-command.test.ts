import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { runDaemonInstall } from "../daemon-cli/install.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";

// A missing target must never select the updater's old native/config writer.
vi.mock("../daemon-cli/install.js", () => ({ runDaemonInstall: vi.fn() }));

it.each(["git", "unknown"] as const)(
  "refuses a missing %s target without installing through the old runtime",
  async (mode) => {
    vi.mocked(runDaemonInstall).mockClear();
    await withTestDir({ prefix: "openclaw-native-missing-target-" }, async (root) => {
      const onGatewayStartAttempted = vi.fn();
      await expect(
        runUpdatedInstallGatewayCommand(
          {
            result: { root, mode },
            opts: { json: true },
            invocationEnv: {},
            onGatewayStartAttempted,
          },
          "install",
        ),
      ).rejects.toThrow("updated install entrypoint not found");
      expect(runDaemonInstall).not.toHaveBeenCalled();
      expect(onGatewayStartAttempted).not.toHaveBeenCalled();
    });
  },
);

it.each([
  "installed",
  "load-failed",
  "operator-edit",
  "compensated",
  "invalid-receipt",
  "compensation-failed",
])(
  "retains installer warnings and rollback evidence after child settlement: %s",
  async (outcome) => {
    await withTestDir({ prefix: "openclaw-definition-response-" }, async (root) => {
      await fs.mkdir(path.join(root, "dist"));
      const backup = {
        id: "00000000-0000-4000-8000-000000000001",
        files: [{ sourcePath: path.join(root, "service"), before: null, after: null }],
        guards: [],
      };
      const warning =
        outcome === "compensated"
          ? "previous definition was restored"
          : outcome === "operator-edit"
            ? "Service.Nice preserved"
            : "Service.KillMode repaired";
      const preserved = outcome === "operator-edit" || outcome === "compensated";
      const compensationFailed = outcome === "compensation-failed";
      const failed = preserved || compensationFailed || outcome === "load-failed";
      const error = compensationFailed
        ? "UPDATE_NATIVE_AUTHORITY: Service definition recovery is unverified: Error: SERVICE_DEFINITION_UNKNOWN: Scheduled Task changed"
        : preserved
          ? outcome === "compensated"
            ? "SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: ENOSPC"
            : "SERVICE_DEFINITION_UNKNOWN: Service.Nice"
          : "load failed";
      await fs.writeFile(
        path.join(root, "dist", "index.mjs"),
        `process.stdout.write(${JSON.stringify(
          JSON.stringify({
            action: "install",
            ok: !failed,
            warnings: [warning],
            ...(failed ? { error } : {}),
            ...(!preserved && !compensationFailed
              ? { definitionBackup: outcome === "invalid-receipt" ? { files: [] } : backup }
              : {}),
          }),
        )}); process.exitCode = ${failed ? 1 : 0};`,
      );
      const definitionRecovery: UpdateServiceDefinitionRecovery = {};
      const warnings: string[] = [];
      const result = runUpdatedInstallGatewayCommand(
        {
          result: { root, mode: "npm" },
          opts: { json: true },
          invocationEnv: {},
          definitionRecovery,
          onWarnings: (messages) => warnings.push(...messages),
        },
        "install",
      );
      if (failed) {
        await expect(result).rejects.toThrow(error);
      } else {
        await expect(result).resolves.toBe("unverified");
      }
      expect(warnings).toContain(warning);
      if (preserved) {
        expect(definitionRecovery).toEqual({ preserved: true, unverified: false });
      } else if (outcome === "invalid-receipt" || compensationFailed) {
        expect(definitionRecovery).toEqual({ unverified: true });
        expect(warnings).toContainEqual(expect.stringContaining("receipt could not be verified"));
      } else {
        expect(definitionRecovery).toEqual({ backup, unverified: false });
      }
    });
  },
);

it("restarts the updated runtime without admitting another definition writer", async () => {
  await withTestDir({ prefix: "openclaw-definition-restart-" }, async (root) => {
    await fs.mkdir(path.join(root, "dist"));
    const received = path.join(root, "received-arguments");
    const activation = path.join(root, "activation-attempted");
    await fs.writeFile(
      path.join(root, "dist", "index.mjs"),
      `import fs from "node:fs";
       fs.readFileSync(${JSON.stringify(activation)});
       fs.writeFileSync(${JSON.stringify(received)}, process.argv.slice(2).join("\\n"));
       process.stdout.write(JSON.stringify({ action: "restart", ok: true, result: "restarted" }));`,
    );
    await expect(
      runUpdatedInstallGatewayCommand(
        {
          result: { root, mode: "npm" },
          opts: { json: true },
          invocationEnv: {},
          onGatewayStartAttempted: () => writeFileSync(activation, "attempted"),
        },
        "restart",
      ),
    ).resolves.toBe("accepted");
    expect((await fs.readFile(received, "utf8")).split("\n")).toContain("--preserve-definition");
  });
});
