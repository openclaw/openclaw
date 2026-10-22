import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createFinalizeArgs } from "./setup.finalize.fixtures.test-support.js";
import { ensureGatewayServiceForOnboarding } from "./setup.finalize.js";

// systemd reports a stopped, disabled unit as not loaded, but its definition remains.
const service = vi.hoisted(() => ({
  isLoaded: vi.fn(async () => false),
  hasInstalledDefinition: vi.fn(async () => true),
  install: vi.fn(async () => {}),
  restart: vi.fn(async () => ({ outcome: "completed" as const })),
  readCommand: vi.fn(async () => null),
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => service,
}));
vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  isSystemdUserServiceAvailable: async () => true,
}));
vi.mock("../commands/systemd-linger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/systemd-linger.js")>()),
  ensureSystemdUserLingerInteractive: async () => {},
}));

describe("ensureGatewayServiceForOnboarding", () => {
  it("offers the existing-service menu for an installed but disabled unit", async () => {
    const prompter = createWizardPrompter(undefined, { defaultSelect: "skip" });

    const result = await ensureGatewayServiceForOnboarding(
      createFinalizeArgs("quickstart", { opts: { installDaemon: true }, prompter }),
    );

    expect(result.gateway).toEqual({ status: "ready", action: "reused" });
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Gateway service already installed" }),
    );
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });
});
