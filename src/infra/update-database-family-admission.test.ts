import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateDatabaseFamilyAdmission } from "../cli/update-cli/update-command-candidate-validation.js";
import { createUpdateCommandExecutionGuards } from "../cli/update-cli/update-command-execution-guards.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.10.16";

it.each(["legacy", "global-postgres", "family-refusal", "family-compatible"])(
  "requires family proof before activation from %s",
  async (kind) => {
    const root = directories.make("database-family-candidate-");
    const source = path.join(root, "openclaw.json");
    const candidate = path.join(root, "candidate");
    const config = { database: { families: { workboard: { engine: "postgres" } } } };
    await fs.mkdir(path.join(candidate, "dist"), { recursive: true });
    await fs.writeFile(source, JSON.stringify(config));
    const openclaw = {
      databaseEngines: ["sqlite", "postgres"],
      ...(kind !== "legacy" ? { updateAdmissionProtocol: 1 } : {}),
    };
    const manifest = { version, packageManager: "npm@11.0.0", type: "module", openclaw };
    await fs.writeFile(path.join(candidate, "package.json"), JSON.stringify(manifest));
    const refused = kind === "family-refusal";
    const checks = [
      { name: "config", status: "ok" },
      ...(kind.startsWith("family-")
        ? [{ name: "database-families", status: refused ? "refuse" : "ok" }]
        : []),
    ];
    await fs.writeFile(
      path.join(candidate, "dist", "index.js"),
      `
        const { readFile } = await import('node:fs/promises');
        const context = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
        if (context.target.channel !== 'stable' || context.request.noRestart !== true || context.installation.packageManager !== 'npm') {
          throw new Error('Candidate did not receive the selected update context');
        }
        process.stdout.write(JSON.stringify({
          protocol: 1, verdict: ${JSON.stringify(refused ? "refuse" : "admit")},
          reasons: ${JSON.stringify(refused ? [{ code: "database-engine-preflight", message: "Selected family unsupported" }] : [])},
          warnings: [], facts: { candidateVersion: ${JSON.stringify(version)}, installedVersion: null, checks: ${JSON.stringify(checks)} },
        }));
        process.exitCode = ${refused ? 3 : 0};
      `,
    );
    const before = await fs.readFile(source);
    let activated = false;
    const opts = { json: true };
    const familyAdmission = createUpdateDatabaseFamilyAdmission({
      root,
      updateInstallKind: "package",
      updateStepTimeoutMs: 30_000,
      channel: "stable",
      tag: version,
      packageInstallSpec: null,
      opts,
      executionGuards: createUpdateCommandExecutionGuards(opts, root),
      shouldRestart: false,
    });
    const env = { OPENCLAW_CONFIG_PATH: source, OPENCLAW_STATE_DIR: root };
    familyAdmission.selectContexts([{ config: JSON.parse(before.toString()), env }]);
    const admission = familyAdmission.validate(candidate).then(() => {
      familyAdmission.assertAdmitted();
      activated = true;
    });
    if (kind === "family-compatible") {
      await admission;
    } else {
      await expect(admission).rejects.toThrow(
        /candidate did not prove support for database.families/,
      );
    }
    expect(activated).toBe(kind === "family-compatible");
    expect(await fs.readFile(source)).toEqual(before);
  },
);
