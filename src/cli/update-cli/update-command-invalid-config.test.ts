import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

it.each(
  [false, true].flatMap((dryRun) =>
    [
      { kind: "unknown key", config: { unknownSetting: true } },
      { kind: "invalid core field", config: { gateway: { port: "invalid" } } },
    ].map(({ kind, config }) => ({ kind, config, dryRun })),
  ),
)("identifies $kind during installed admission (dryRun=$dryRun)", async ({ config, dryRun }) => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH!;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const original = JSON.stringify(config);
  fs.writeFileSync(configPath, original);

  const update = updateCommand({
    admission: "installed",
    tag: "2026.9.2",
    json: true,
    yes: true,
    restart: false,
    dryRun,
  });
  if (dryRun) {
    await update;
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        notes: [expect.stringMatching(/configuration is invalid[\s\S]*openclaw doctor --fix/)],
      }),
    );
  } else {
    await expect(update).rejects.toMatchObject({ code: 1 });
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        reason: "invalid-config",
        steps: [
          expect.objectContaining({
            failureFacts: [
              expect.objectContaining({ check: "invalid-config", code: "invalid-config" }),
            ],
          }),
        ],
      }),
    );
  }
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
});
