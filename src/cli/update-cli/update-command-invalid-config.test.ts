import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as materialize from "../../config/materialize.js";
import * as installSurface from "../../infra/update-runner-install-surface.js";
import { defaultRuntime } from "../../runtime.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

it.each(
  [false, true].flatMap((dryRun) => [
    { kind: "unknown key", config: { unknownSetting: true }, affectedKey: "<root>", dryRun },
    {
      kind: "invalid core field",
      config: { gateway: { port: "invalid" } },
      affectedKey: "gateway.port",
      dryRun,
    },
  ]),
)(
  "identifies $kind during installed admission (dryRun=$dryRun)",
  async ({ config, dryRun, affectedKey }) => {
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
                expect.objectContaining({
                  check: "invalid-config",
                  code: "invalid-config",
                  affectedKey,
                }),
              ],
            }),
          ],
        }),
      );
    }
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
  },
);

it.each(["file", "materialization", "include", "include-syntax"])(
  "classifies a config %s failure without changing its source",
  async (failure) => {
    vi.spyOn(installSurface, "resolveUpdateInstallSurface").mockRejectedValue(
      new Error("Package-manager inspection must not replace the config failure"),
    );
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    const original = failure.startsWith("include")
      ? '{"$include":"./extra.json"}'
      : '{"gateway":{"mode":"local"}}';
    if (failure === "file") {
      fs.mkdirSync(configPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, original);
      if (failure === "materialization") {
        vi.spyOn(materialize, "materializeRuntimeConfig").mockImplementation(() => {
          throw new Error("Synthetic materialization failure after reading source bytes");
        });
      } else if (failure === "include-syntax") {
        fs.writeFileSync(path.join(path.dirname(configPath), "extra.json"), "{");
      }
    }

    await expect(
      updateCommand({
        admission: "installed",
        channel: "stable",
        tag: "2026.9.2",
        json: true,
        yes: true,
        restart: false,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        reason: failure === "include-syntax" ? "invalid-config" : "config-read-failed",
        steps: [
          expect.objectContaining({
            failureFacts: [
              expect.objectContaining({
                check: failure === "include-syntax" ? "invalid-config" : "config",
                code:
                  failure === "file"
                    ? "EISDIR"
                    : failure === "include-syntax"
                      ? "invalid-config"
                      : "config-read-failed",
              }),
            ],
          }),
        ],
      }),
    );
    if (failure === "file") {
      expect(fs.statSync(configPath).isDirectory()).toBe(true);
    } else {
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    }
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
  },
);
