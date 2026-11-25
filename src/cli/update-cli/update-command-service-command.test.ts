import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";

it.each(["installed", "load-failed", "start-refused", "invalid-receipt", "compensation-failed"])(
  "retains installer warnings and rollback evidence after child settlement: %s",
  async (outcome) => {
    await withTestDir({ prefix: "openclaw-definition-response-" }, async (root) => {
      await fs.mkdir(path.join(root, "dist"));
      const backup = {
        id: "00000000-0000-4000-8000-000000000001",
        files: [{ sourcePath: path.join(root, "service"), before: null, after: null }],
        guards: [],
      };
      const preserved = outcome === "start-refused";
      const warning = "installer warning";
      const compensationFailed = outcome === "compensation-failed";
      const failed = preserved || compensationFailed || outcome === "load-failed";
      const error = compensationFailed
        ? "UPDATE_NATIVE_AUTHORITY: Service definition recovery is unverified: Error: SERVICE_DEFINITION_UNKNOWN: Scheduled Task changed"
        : preserved
          ? "SERVICE_DEFINITION_UNKNOWN: Service is masked. Run `systemctl --user unmask openclaw-gateway.service`."
          : "load failed";
      const response = JSON.stringify({
        action: "install",
        ok: !failed,
        warnings: [warning],
        ...(failed ? { error } : {}),
        ...(!preserved && !compensationFailed
          ? { definitionBackup: outcome === "invalid-receipt" ? { files: [] } : backup }
          : {}),
      });
      await fs.writeFile(
        path.join(root, "dist", "index.mjs"),
        `process.stdout.write(${JSON.stringify(response)}); process.exitCode = ${failed ? 1 : 0};`,
      );
      const definitionRecovery: UpdateServiceDefinitionRecovery = {};
      const warnings: string[] = [];
      const result = runUpdatedInstallGatewayCommand(
        {
          result: { root, mode: "npm" },
          opts: {},
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

it.each(["restarted", "scheduled"])("retains restart facts (%s)", async (result) => {
  await withTestDir({ prefix: "openclaw-definition-restart-" }, async (root) => {
    await fs.mkdir(path.join(root, "dist"));
    const received = path.join(root, "received-arguments");
    const activation = path.join(root, "activation-attempted");
    const onReadiness = vi.fn();
    const readiness = { healthy: true, startupPhase: "ready" };
    await fs.writeFile(
      path.join(root, "dist", "index.mjs"),
      `import fs from "node:fs";
       fs.readFileSync(${JSON.stringify(activation)});
       fs.writeFileSync(${JSON.stringify(received)}, process.argv.slice(2).join("\\n"));
       process.stdout.write(JSON.stringify({ action: "restart", ok: true, result: "${result}", readiness: ${JSON.stringify(readiness)} }));`,
    );
    await expect(
      runUpdatedInstallGatewayCommand(
        {
          result: { root, mode: "npm" },
          opts: {},
          invocationEnv: {},
          onReadiness,
          onGatewayStartAttempted: () => writeFileSync(activation, "attempted"),
        },
        "restart",
      ),
    ).resolves.toBe("accepted");
    expect((await fs.readFile(received, "utf8")).split("\n")).toContain("--preserve-definition");
    expect(onReadiness.mock.calls).toEqual(result === "restarted" ? [[readiness]] : []);
  });
});
