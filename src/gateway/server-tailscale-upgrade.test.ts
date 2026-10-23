import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGatewayStartupOperations } from "../cli/gateway-cli/run-loop-startup.js";
import { captureEnv } from "../test-utils/env.js";
import { startGatewayTailscaleExposure } from "./server-tailscale.js";
import { getTailscalePublishedOrigin } from "./tailscale-published-origin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("managed Tailscale upgrade", () => {
  const host = "fixture.tailnet.ts.net:443";
  const handler = (port: number) => ({ Proxy: `http://127.0.0.1:${port}/` });
  const legacyRoute = (
    funnel = false,
    proxyPort = 18789,
    paths: Record<string, ReturnType<typeof handler>> = { "/": handler(proxyPort) },
  ) => ({
    TCP: { "443": { HTTPS: true } },
    Web: { [host]: { Handlers: paths } },
    ...(funnel ? { AllowFunnel: { [host]: true } } : {}),
  });

  const installFixture = async (config: object, mode: "serve" | "funnel") => {
    const fixture = fileURLToPath(
      new URL("../../test/fixtures/tailscale-legacy-route-fixture.mjs", import.meta.url),
    );
    const marker = path.join(tempDirs.make("openclaw-tailscale-upgrade-"), "state");
    await symlink(fixture, path.join(path.dirname(marker), "tailscale"));
    await writeFile(marker, JSON.stringify(config));
    process.env.PATH = `${path.dirname(marker)}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = fixture;
    process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER = marker;
    process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE = mode;
    process.env.VITEST ??= "true";
    return marker;
  };

  let cleanup: Awaited<ReturnType<typeof startGatewayTailscaleExposure>>;
  beforeEach(() => {
    cleanup = null;
    const env = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_CLAIMS",
      "VITEST",
      "PATH",
    ]);
    return async () => {
      try {
        await cleanup?.();
      } finally {
        env.restore();
      }
    };
  });

  const expose = async (
    mode: "serve" | "funnel",
    port = 18789,
    info = vi.fn(),
    signal?: AbortSignal,
  ) =>
    (cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: mode,
      port,
      backend: { host: "127.0.0.1", port: 19000 },
      logTailscale: { info, warn: () => undefined },
      signal,
    }));

  it.each([
    ["serve", 443],
    ["serve", 18789],
    ["funnel", 19001],
  ] as const)("adopts a predecessor %s route to Gateway port %s", async (mode, port) => {
    const marker = await installFixture(legacyRoute(mode === "funnel", port), mode);
    const info = vi.fn();
    await expose(mode, port, info);
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({});
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("adopted from a previous OpenClaw release"),
    );
  });

  it.each([
    [
      "foreground claim",
      { Foreground: { "fixture-session": legacyRoute(false, 8096) } },
      /Foreground session fixture-session.*fixture\.tailnet\.ts\.net:443[\s\S]*stop the confirmed owning process/,
    ],
    ["foreign target", legacyRoute(false, 8096)],
    [
      "foreign sibling hostname",
      {
        ...legacyRoute(false, 8096),
        Web: {
          ...legacyRoute(false, 8096).Web,
          "old.tailnet.ts.net:443": legacyRoute().Web[host],
        },
      },
    ],
    [
      "foreign sibling path",
      legacyRoute(false, 18789, { "/": handler(18789), "/other": handler(8096) }),
    ],
  ])("does not modify a %s", async (_label, config, recovery = /--https=443 --set-path=\/ off/) => {
    const marker = await installFixture(config, "serve");
    await expect(expose("serve")).rejects.toThrow(recovery);
    expect(await readFile(marker, "utf8")).toBe(JSON.stringify(config));
  });

  it("does not mutate an independent Tailscale Service", async () => {
    const marker = await installFixture({ Services: { "svc:other": legacyRoute() } }, "serve");
    const before = await readFile(marker, "utf8");

    await expose("serve");
    expect(await readFile(marker, "utf8")).toBe(before);
  });

  it.each(["serve", "funnel"] as const)(
    "reclaims %s after the foreground process exits without restarting its Gateway owner",
    async (mode) => {
      const marker = await installFixture({}, mode);
      const claimsPath = path.join(path.dirname(marker), "claims.jsonl");
      process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_CLAIMS = claimsPath;
      const readClaims = async () =>
        (await readFile(claimsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; target: string });
      const gatewayPid = process.pid;
      const startup = createGatewayStartupOperations();
      await startup.run((signal) => expose(mode, 18789, vi.fn(), signal));
      startup.close();
      const originalClaims = await readClaims();
      expect(originalClaims).toHaveLength(1);
      const original = originalClaims[0]!;
      const previousOrigin = getTailscalePublishedOrigin();
      expect(previousOrigin?.origin).toBe("https://fixture.tailnet.ts.net");
      process.kill(original.pid, "SIGTERM");

      // Observe a real worker/CLI exit and replacement, including the recovery backoff.
      await vi.waitFor(async () => expect(await readClaims()).toHaveLength(2), {
        timeout: 5_000,
      });
      await vi.waitFor(() => {
        expect(getTailscalePublishedOrigin()?.signal).not.toBe(previousOrigin?.signal);
        expect(getTailscalePublishedOrigin()).toMatchObject({
          origin: "https://fixture.tailnet.ts.net",
          mode,
        });
      });
      const replacement = (await readClaims())[1]!;
      expect(replacement.pid).not.toBe(original.pid);
      expect(replacement.target).toBe(original.target);
      expect(replacement.target).toBe("19000");
      expect(process.pid).toBe(gatewayPid);
      expect(previousOrigin?.signal.aborted).toBe(true);
      await cleanup?.();
      cleanup = null;
      expect(() => process.kill(replacement.pid, 0)).toThrow();
      expect(getTailscalePublishedOrigin()).toBeUndefined();
    },
  );
});
