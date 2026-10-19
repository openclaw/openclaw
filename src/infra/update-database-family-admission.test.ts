import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateDatabaseFamilyAdmission } from "../cli/update-cli/update-command-candidate-validation.js";

const directories = useAutoCleanupTempDirTracker(afterAll);

describe("installed mixed-engine candidate admission", () => {
  let root: string;
  let source: string;
  const candidates = new Map<string, string>();
  beforeAll(async () => {
    root = directories.make("database-family-candidate-");
    source = path.join(root, "openclaw.json");
    await fs.writeFile(
      source,
      JSON.stringify({ database: { families: { workboard: { engine: "postgres" } } } }),
    );
    for (const kind of ["legacy", "global-postgres", "family-refusal", "family-compatible"]) {
      const candidate = path.join(root, kind);
      candidates.set(kind, candidate);
      await fs.mkdir(path.join(candidate, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(candidate, "package.json"),
        JSON.stringify({
          version: "2026.10.16",
          packageManager: "npm@11.0.0",
          type: "module",
          openclaw: {
            databaseEngines: ["sqlite", "postgres"],
            ...(kind !== "legacy" ? { updateAdmissionProtocol: 1 } : {}),
          },
        }),
      );
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
        process.stdout.write(${JSON.stringify(
          JSON.stringify({
            protocol: 1,
            verdict: refused ? "refuse" : "admit",
            reasons: refused
              ? [{ code: "database-engine-preflight", message: "Selected family unsupported" }]
              : [],
            warnings: [],
            facts: { candidateVersion: "2026.10.16", installedVersion: null, checks },
          }),
        )});
        process.exitCode = ${refused ? 3 : 0};
      `,
      );
    }
  });

  it.each(["legacy", "global-postgres", "family-refusal", "family-compatible"])(
    "requires family proof before activation from %s",
    async (kind) => {
      const before = await fs.readFile(source);
      let activated = false;
      const familyAdmission = createUpdateDatabaseFamilyAdmission({
        root,
        updateInstallKind: "package",
        updateStepTimeoutMs: 30_000,
        channel: "stable",
        tag: "2026.10.16",
        packageInstallSpec: null,
        opts: { json: true },
        shouldRestart: false,
      });
      familyAdmission.selectContexts([
        {
          config: JSON.parse(before.toString()),
          env: { OPENCLAW_CONFIG_PATH: source, OPENCLAW_STATE_DIR: root },
        },
      ]);
      const admission = familyAdmission.validate(candidates.get(kind)!).then(() => {
        familyAdmission.assertAdmitted();
        activated = true;
      });
      if (kind === "family-compatible") {
        await admission;
        expect(activated).toBe(true);
      } else {
        await expect(admission).rejects.toThrow(
          /candidate did not prove support for database.families/,
        );
        expect(activated).toBe(false);
      }
      expect(await fs.readFile(source)).toEqual(before);
    },
  );
});
