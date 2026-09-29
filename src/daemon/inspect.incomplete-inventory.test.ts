import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import { withTestDir } from "../test-helpers/temp-dir.js";
import * as gatewayService from "./service.js";

vi.mock("./systemd-loaded-unit-inventory.js", () => ({ listLoadedSystemdUnits: async () => [] }));
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  const { decodeLaunchAgentPlistFixture } = await import("./launchd-plist.test-support.js");
  return {
    ...actual,
    runExec: vi.fn(async (...args: Parameters<typeof actual.runExec>) => {
      const options = args[2];
      const input = typeof options === "object" ? options.input : undefined;
      return input === undefined
        ? actual.runExec(...args)
        : decodeLaunchAgentPlistFixture(input, args[1][1]);
    }),
  };
});

import { listManagedOpenClawGatewayServices } from "./inspect.js";

it.each([
  ["linux", ".config/systemd/user/custom-worker.service", false],
  ["linux", ".config/systemd/user/openclaw-gateway.service", true],
  ["darwin", "Library/LaunchAgents/org.example.custom-worker.plist", false],
  ["darwin", "Library/LaunchAgents/ai.openclaw.broken.plist", true],
] as const)(
  "handles unreadable paths in complete %s inventories: %s",
  async (platform, relative, required) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    try {
      await withTestDir({ prefix: "openclaw-incomplete-inventory-" }, async (home) => {
        const readdir = fs.readdir;
        const directories = vi
          .spyOn(fs, "readdir")
          .mockImplementation((...args: Parameters<typeof fs.readdir>) => {
            const dir = args[0];
            return typeof dir === "string" && (dir === home || dir.startsWith(`${home}${path.sep}`))
              ? readdir(...args)
              : Promise.resolve([]);
          });
        try {
          const unreadable = path.join(home, relative);
          // A directory in place of a service file fails reads even as root.
          await fs.mkdir(unreadable, { recursive: true });
          await expect(listManagedOpenClawGatewayServices({ HOME: home })).resolves.toEqual({
            services: [],
            errors: required
              ? [{ source: unreadable, message: "Service path could not be inspected." }]
              : [],
          });
          await expect(
            listManagedOpenClawGatewayServices({ HOME: home }, { requireComplete: true }),
          ).resolves.toEqual({
            services: [],
            errors: required
              ? [{ source: unreadable, message: "Service path could not be inspected." }]
              : [],
          });
        } finally {
          directories.mockRestore();
        }
      });
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  },
);

it("admits an unrelated unreadable launchd plist and still fences a live Gateway", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  try {
    await withTestDir({ prefix: "openclaw-launchd-fence-" }, async (home) => {
      const checkout = path.join(home, "openclaw");
      const other = path.join(home, "other");
      for (const root of [checkout, other]) {
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}\n');
        await fs.writeFile(path.join(root, "dist", "index.js"), "gateway\n");
      }
      const agents = path.join(home, "Library", "LaunchAgents");
      await fs.mkdir(path.join(agents, "org.example.custom-worker.plist"), { recursive: true });
      const readdir = fs.readdir;
      const directories = vi
        .spyOn(fs, "readdir")
        .mockImplementation((...args: Parameters<typeof fs.readdir>) => {
          const dir = args[0];
          return typeof dir === "string" && (dir === home || dir.startsWith(`${home}${path.sep}`))
            ? readdir(...args)
            : Promise.resolve([]);
        });
      const label = "ai.openclaw.gateway.dev";
      const readState = vi
        .spyOn(gatewayService, "readGatewayServiceState")
        .mockImplementation(async (_service, input) => {
          const live = input?.env?.OPENCLAW_LAUNCHD_LABEL === label;
          return {
            installed: live,
            loadState: { status: live ? "loaded" : "not-loaded" },
            running: live,
            env: {},
            command: live
              ? {
                  programArguments: [
                    process.execPath,
                    path.join(checkout, "dist", "index.js"),
                    "gateway",
                  ],
                }
              : {
                  programArguments: [
                    process.execPath,
                    path.join(other, "dist", "index.js"),
                    "gateway",
                  ],
                },
            runtime: { status: live ? "running" : "stopped" },
          };
        });
      try {
        const env = { HOME: home };
        await expect(
          resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
        ).resolves.toEqual({ refuse: false });

        await fs.writeFile(
          path.join(agents, `${label}.plist`),
          `<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${path.join(checkout, "dist", "index.js")}</string><string>gateway</string></array></dict></plist>`,
        );
        await expect(
          resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
        ).resolves.toMatchObject({
          refuse: true,
          message: expect.stringContaining("profile gateway.dev"),
        });
      } finally {
        readState.mockRestore();
        directories.mockRestore();
      }
    });
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  }
});
