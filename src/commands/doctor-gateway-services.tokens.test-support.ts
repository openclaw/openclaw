import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import { withEnvAsync } from "../test-utils/env.js";
import { makeDoctorIo, makeDoctorPrompts } from "./doctor-gateway-runtime.test-utils.js";
import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";
import { mocks, expectNoteContaining } from "./doctor-gateway-services.native.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

export function registerDoctorGatewayTokenRepairTests({
  runRepair,
  setupGatewayTokenRepairScenario,
}: {
  runRepair: (config: OpenClawConfig) => Promise<void>;
  setupGatewayTokenRepairScenario: () => void;
}) {
  it("reports skipped token preservation without a TTY even with --yes", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      setupGatewayTokenRepairScenario();
      const runtime = makeDoctorIo();
      await maybeRepairGatewayServiceConfig(
        { gateway: {} },
        "local",
        runtime,
        createDoctorPrompter({
          runtime,
          options: {
            repair: false,
            yes: true,
            nonInteractive: false,
          },
        }),
        { writeConfig: mocks.writeConfig },
      );
      expect(mocks.preserveGatewayAuthTokenForService).not.toHaveBeenCalled();
      expect(mocks.writeConfig).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expectNoteContaining(
        "Skipped Gateway token preservation and service repair",
        "Gateway service config",
      );
    });
  });

  it("leaves config and service unchanged when the secret store is unavailable", async () => {
    setupGatewayTokenRepairScenario();
    mocks.preserveGatewayAuthTokenForService.mockRejectedValueOnce(
      new Error("Secret store database is unavailable."),
    );
    await runRepair({ gateway: {} });
    expect(mocks.writeConfig).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it.each(["ordinary", "post-commit"] as const)(
    "stops service repair after a %s token persistence error",
    async (kind) => {
      await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
        setupGatewayTokenRepairScenario();
        const cfg: OpenClawConfig = { gateway: {} };
        const runtime = makeDoctorIo();
        const cause = new Error("token persistence failed");
        const failure =
          kind === "post-commit"
            ? new ConfigWritePostCommitError({
                configPath: "/tmp/openclaw.json",
                rollbackStatus: "not-restored",
                cause,
              })
            : cause;
        mocks.writeConfig.mockRejectedValueOnce(failure);

        const repair = maybeRepairGatewayServiceConfig(cfg, "local", runtime, makeDoctorPrompts(), {
          writeConfig: mocks.writeConfig,
        });
        if (kind === "post-commit") {
          await expect(repair).rejects.toBe(failure);
        } else {
          await expect(repair).resolves.toBe(cfg);
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to persist gateway.auth.token before service repair:"),
          );
        }
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).not.toHaveBeenCalled();
      });
    },
  );
}
