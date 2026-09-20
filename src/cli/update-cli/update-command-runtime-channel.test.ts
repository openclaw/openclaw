import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import { registerUpdateCli } from "../update-cli.js";
import * as shared from "./shared.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import { unsupportedServiceRuntimeFixture } from "./update-command-runtime-recovery.test-support.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
const { fixture } = installFreshUpdateFixture();

it.each([
  ["extended-stable", "2026.8.33", "--channel extended-stable", null],
  ["stable", "2026.9.4", "--tag 2026.9.4", null],
  ["beta", "2026.9.4-beta.1", "--tag 2026.9.4-beta.1", null],
  ["dev", "2026.9.4-dev.1", "--tag 2026.9.4-dev.1", null],
  ["stable", "2026.8.33", "--channel extended-stable", "extended-stable"],
  ["extended-stable", "2026.9.4", "--channel stable --tag 2026.9.4", "stable"],
  ["extended-stable", "2026.9.4-beta.1", "--channel beta --tag 2026.9.4-beta.1", "beta"],
] as const)(
  "replays runtime recovery for saved %s (%s, %s, requested=%s) through the target resolver",
  async (channel, version, selector, requestedChannel) => {
    vi.stubEnv("OPENCLAW_PROFILE", undefined);
    const configPath = expectDefined(process.env.OPENCLAW_CONFIG_PATH, "isolated config path");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = JSON.stringify({ update: { channel } });
    fs.writeFileSync(configPath, config);
    fixture.managedServiceNodeRunner = "/home/operator/.nvm/versions/node/v22.18.0/bin/node";
    const prepare = expectDefined(
      vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation(),
      "fixture preparation",
    );
    vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (opts) => ({
      ...(await prepare(opts)),
      requestedChannel: normalizeUpdateChannel(opts.channel),
    }));
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockImplementation(
      async ({ target }) => ({
        ...targetMetadata,
        target,
        version,
        nodeEngine: ">=24.16.0",
      }),
    );
    vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({ tag: channel, version });
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue(version);
    const runtime = vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo");
    runtime.mockResolvedValue(unsupportedServiceRuntimeFixture);
    const preflight = vi.spyOn(servicePlan, "resolvePackageRuntimePreflight");

    const options = {
      channel: requestedChannel ?? undefined,
      json: true,
      yes: true,
      restart: false,
      ...(channel === "dev" ? { tag: version } : {}),
    };
    await updateCommand({ ...options, dryRun: true });

    const previewResult = expectDefined(preflight.mock.results.at(-1), "runtime refusal");
    if (previewResult.type !== "return") {
      throw new Error("Runtime preflight did not return its outcome");
    }
    const refusal = await previewResult.value;
    expect(refusal.ok).toBe(false);
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        storedChannel: channel,
        targetVersion: version,
        failures: [expect.objectContaining({ reason: "node-runtime-preflight" })],
      }),
    );
    await expect(updateCommand(options)).rejects.toBeInstanceOf(Error);
    const mutableResult = expectDefined(preflight.mock.results.at(-1), "mutable runtime refusal");
    if (mutableResult.type !== "return") {
      throw new Error("Mutable runtime preflight did not return its outcome");
    }
    const mutableRefusal = await mutableResult.value;
    expect(mutableRefusal.recoverySteps).toEqual(refusal.recoverySteps);
    const continuation = expectDefined(
      refusal.recoverySteps?.find((step) => step.kind === "continue-update"),
      "retained-launcher continuation",
    );
    if (!("command" in continuation)) {
      throw new Error("Runtime recovery did not provide a continuation command");
    }
    const command = continuation.command;
    const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
    const launcher = `node ${quote(path.join(fixture.root, "openclaw.mjs"))} `;
    expect(command.slice(0, launcher.length)).toBe(launcher);
    runtime.mockResolvedValue({
      status: "supported",
      version: "26.1.0",
      sqliteVersion: "3.53.0",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.53.0", text: true, blob: true, json: true },
    });
    const program = new Command();
    registerUpdateCli(program);

    await program.parseAsync(
      [
        ...command.slice(launcher.length).split(" "),
        "--dry-run",
        "--json",
        "--yes",
        "--no-restart",
      ],
      { from: "user" },
    );

    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        effectiveChannel: requestedChannel ?? channel,
        targetVersion: version,
      }),
    );
    expect(vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "failures",
    );
    expect(command).toBe(`${launcher}update ${selector}`);
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(config);
  },
);
