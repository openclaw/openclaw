import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import * as devUpdateTarget from "../../infra/update-dev-target.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { invokeUpdateCli } from "../update-cli-invocation.test-support.js";
import { registerUpdateCli } from "../update-cli.js";
import {
  expectFreshStatePreserved,
  installFreshUpdateFixture,
  writeFreshJson,
} from "./update-command-fresh.test-support.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
const inheritedRunIds = ["  1c5a25f3-f46a-408b-a87f-a0f0d1f80ee7  ", " \t "] as const;

function writeConfig(config: unknown) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH!;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  return writeFreshJson(configPath, config);
}

function writeStoredChannel(channel: "stable" | "beta" | "dev") {
  return writeConfig({ update: { channel } });
}

function expectJson(result: unknown) {
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining(result));
}

describe("update command admission with fresh state", () => {
  it("reports an invalid dev preview without creating runtime state", async () => {
    const config = writeStoredChannel("dev");
    const configBytes = fs.readFileSync(config, "utf8");
    const packagePath = path.join(fixture.root, "package.json");
    const packageBytes = fs.readFileSync(packagePath, "utf8");
    vi.spyOn(devUpdateTarget, "readDevUpdateTarget").mockImplementation(() => {
      throw new Error("fixture invalid dev target");
    });
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new ExitError(code);
    });

    await expect(
      invokeUpdateCli({
        tag: "2026.9.2",
        yes: true,
        json: true,
        restart: false,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith("fixture invalid dev target");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expectFreshStatePreserved(fixture);
    expect(exit).not.toHaveBeenCalled();
    expect(createManagedHandoffLeaseStore().read(fixture.root).kind).toBe("absent");
    expect(fs.readFileSync(config, "utf8")).toBe(configBytes);
    expect(fs.readFileSync(packagePath, "utf8")).toBe(packageBytes);
  });

  it("registered update CLI reports the installed version for fresh saved-dev previews", async () => {
    writeStoredChannel("dev");
    vi.stubEnv("OPENCLAW_GIT_DIR", path.join(fixture.root, "missing-checkout"));
    const program = new Command();
    registerUpdateCli(program);

    await program.parseAsync(["update", "--dry-run", "--json", "--no-restart"], { from: "user" });

    expectJson({
      currentVersion: "2026.9.3",
      targetVersion: null,
      targetVersionReason: expect.stringContaining("Git"),
      switchToGit: true,
    });
    expect(vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0]).toHaveProperty("run", undefined);
    expectFreshStatePreserved(fixture);
  });

  it("previews an older stable without runtime state despite an inherited run", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", inheritedRunIds[0]);
    await updateCommand({ tag: "2026.9.2", dryRun: true, json: true, restart: false });

    expectJson({
      dryRun: true,
      currentVersion: "2026.9.3",
      targetVersion: "2026.9.2",
      downgradeRisk: true,
    });
    expectFreshStatePreserved(fixture);
  });
});
