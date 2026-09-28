import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gatewayServiceCommandUsesRoot } from "../cli/update-cli/update-command-service-plan.js";
import { summarizeGatewayServiceLayout } from "./service-layout.js";

describe("summarizeGatewayServiceLayout", () => {
  it.each(
    [
      ["node", "dist/index.js", "gateway", "run"],
      ["node", "--title", "gateway", "dist/index.js", "--profile", "dev", "gateway"],
      ["bun", "run", "dist/index.js", "--profile=gateway", "gateway"],
      ["tsx", "watch", "dist/index.js", "--dev", "gateway"],
      ["dist/index.js", "--profile", "dev", "gateway"],
    ].map((programArguments) => ({ programArguments })),
  )(
    "resolves a relative entrypoint against an absolute working directory: $programArguments",
    async ({ programArguments }) => {
      expect(
        (
          await summarizeGatewayServiceLayout({
            programArguments,
            workingDirectory: "/repo/openclaw",
          })
        )?.entrypoint,
      ).toBe(path.join("/repo/openclaw", "dist", "index.js"));
    },
  );

  it("resolves a shell file launcher without mistaking CLI root options for the script", async () => {
    expect(
      (
        await summarizeGatewayServiceLayout({
          programArguments: ["/bin/sh", "bin/gateway.sh", "--profile", "dev", "gateway"],
          workingDirectory: "/repo/openclaw",
        })
      )?.entrypoint,
    ).toBe(path.join("/repo/openclaw", "bin", "gateway.sh"));
  });

  it("resolves Windows service entrypoints with Windows path semantics", async () => {
    expect(
      (
        await summarizeGatewayServiceLayout({
          programArguments: ["node.exe", "dist\\index.js", "gateway", "run"],
          workingDirectory: "C:\\openclaw",
        })
      )?.entrypoint,
    ).toBe("C:\\openclaw\\dist\\index.js");
  });

  it("rejects a relative entrypoint without an absolute service working directory", async () => {
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
      }),
    ).resolves.not.toHaveProperty("entrypoint");
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
        workingDirectory: "./checkout",
      }),
    ).resolves.not.toHaveProperty("entrypoint");
  });

  it.each([
    { label: "readable", buildInfo: '{"version":"2026.9.5","buildId":"build-on-disk"}' },
    { label: "unwritten", buildInfo: undefined },
    { label: "truncated", buildInfo: '{"version":"2026.9.5","buil' },
    { label: "over-long", buildInfo: `{"buildId":"${"b".repeat(97)}"}` },
  ])("reports the build id currently on disk ($label)", async ({ label, buildInfo }) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-layout-build-id-")),
    );
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.5"}');
    await fs.writeFile(path.join(root, "dist", "index.js"), "gateway");
    if (buildInfo !== undefined) {
      await fs.writeFile(path.join(root, "dist", "build-info.json"), buildInfo);
    }
    const layout = await summarizeGatewayServiceLayout({
      programArguments: [process.execPath, path.join(root, "dist", "index.js"), "gateway", "run"],
    });
    expect(layout?.packageRoot).toBe(root);
    // Only a complete, bounded identity is reportable: a partial build-info must not
    // become a build id that status then compares against the running Gateway.
    expect(layout?.packageBuildId).toBe(label === "readable" ? "build-on-disk" : undefined);
  });
});

describe("gatewayServiceCommandUsesRoot release ownership", () => {
  it.each(["stable", "foreign", "pinned", "paired", "different-mount"] as const)(
    "checks the effective launcher against the managed installation (%s)",
    async (layout) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-release-owner-")),
      );
      try {
        const managedRoot = path.join(root, "openclaw");
        const release = path.join(root, "releases", "selected");
        const foreign = path.join(root, "foreign", "releases", "selected");
        const current = path.join(root, "current");
        const mounted = layout === "paired" || layout === "different-mount";
        for (const packageRoot of [managedRoot, release, foreign, ...(mounted ? [current] : [])]) {
          await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
          await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
          await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "gateway");
        }
        if (!mounted) {
          await fs.symlink(layout === "foreign" ? foreign : release, current);
        } else if (layout === "paired") {
          // The Docker proof supplies real bind mounts; this isolates directory identity.
          const selected = await fs.stat(release);
          const stat = fs.stat.bind(fs);
          vi.spyOn(fs, "stat").mockImplementation(async (target) =>
            path.resolve(String(target)) === current ? selected : stat(target),
          );
        }
        const command = {
          programArguments: [
            process.execPath,
            path.join(layout === "pinned" ? release : current, "dist", "index.js"),
            "gateway",
          ],
          managedDefinition: {
            programArguments: [
              process.execPath,
              path.join(managedRoot, "dist", "index.js"),
              "gateway",
            ],
          },
        };
        await expect(gatewayServiceCommandUsesRoot({ root: managedRoot, command })).resolves.toBe(
          layout === "stable" || layout === "paired",
        );
        await expect(
          gatewayServiceCommandUsesRoot({ root: managedRoot, command: command.managedDefinition }),
        ).resolves.toBe(true);
      } finally {
        vi.restoreAllMocks();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
