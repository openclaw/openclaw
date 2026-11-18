import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canOfferGatewayServiceForOnboarding } from "./setup.gateway-service-offer.js";

const { blockMessage, unsupportedReason, systemdAvailable } = vi.hoisted(() => ({
  blockMessage: vi.fn<() => string | undefined>(),
  unsupportedReason: vi.fn<() => string | undefined>(),
  systemdAvailable: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../cli/daemon-cli/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/shared.js")>()),
  resolveDaemonInstallBlockMessage: blockMessage,
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => ({ unsupportedReason: unsupportedReason() }),
}));
vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  isSystemdUserServiceAvailable: systemdAvailable,
}));

describe("canOfferGatewayServiceForOnboarding", () => {
  const argv = process.argv;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const durable = path.join(path.sep, "usr", "lib", "node_modules", "openclaw", "openclaw.mjs");

  beforeEach(() => {
    process.argv = ["node", durable];
    systemdAvailable.mockResolvedValue(true);
  });

  afterEach(() => {
    process.argv = argv;
    Object.defineProperty(process, "platform", platform);
    vi.resetAllMocks();
  });

  it("offers the service on a durable install of a supported host", async () => {
    await expect(canOfferGatewayServiceForOnboarding()).resolves.toBe(true);
  });

  it("offers the service when running from npx", async () => {
    // Accepting installs a durable copy first, so the npx, dlx, or temp copy can be evicted.
    process.argv = ["node", path.join(path.sep, "home", "test", ".npm", "_npx", "abc", "openclaw")];
    await expect(canOfferGatewayServiceForOnboarding()).resolves.toBe(true);
  });

  it("does not offer a service the installer would refuse", async () => {
    blockMessage.mockReturnValue("Nix mode detected; service install is disabled.");
    await expect(canOfferGatewayServiceForOnboarding()).resolves.toBe(false);
  });

  it("does not offer a service on platforms without a service manager", async () => {
    unsupportedReason.mockReturnValue("Gateway service install not supported on freebsd");
    await expect(canOfferGatewayServiceForOnboarding()).resolves.toBe(false);
  });

  it("does not offer a service on Linux without user systemd", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    systemdAvailable.mockResolvedValue(false);
    await expect(canOfferGatewayServiceForOnboarding()).resolves.toBe(false);
  });
});
