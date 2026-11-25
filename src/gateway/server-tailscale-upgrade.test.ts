import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGatewayStartupOperations } from "../cli/gateway-cli/run-loop-startup.js";
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
    vi.stubEnv("PATH", `${path.dirname(marker)}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("OPENCLAW_TEST_TAILSCALE_BINARY", fixture);
    vi.stubEnv("OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER", marker);
    vi.stubEnv("OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE", mode);
    vi.stubEnv("VITEST", process.env.VITEST ?? "true");
    return marker;
  };

  let cleanup: Awaited<ReturnType<typeof startGatewayTailscaleExposure>>;
  beforeEach(() => {
    cleanup = null;
    return async () => {
      try {
        await cleanup?.();
      } finally {
        vi.unstubAllEnvs();
      }
    };
  });

  const expose = async (mode: "serve" | "funnel", port = 18789, signal?: AbortSignal) =>
    (cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: mode,
      port,
      backend: { host: "127.0.0.1", port: 19000 },
      logTailscale: { info: vi.fn(), warn: () => undefined },
      signal,
    }));

  it.each(["serve", "funnel"] as const)("adopts a predecessor %s route", async (mode) => {
    const port = 18789;
    const marker = await installFixture(legacyRoute(mode === "funnel", port), mode);
    await expose(mode, port);
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({});
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
      vi.stubEnv("OPENCLAW_TEST_TAILSCALE_FIXTURE_CLAIMS", claimsPath);
      const readClaims = async () =>
        (await readFile(claimsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; target: string });
      const startup = createGatewayStartupOperations();
      await startup.run((signal) => expose(mode, 18789, signal));
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
      expect([original.target, replacement.target]).toEqual(["19000", "19000"]);
      expect(previousOrigin?.signal.aborted).toBe(true);
      await cleanup?.();
      cleanup = null;
      expect(() => process.kill(replacement.pid, 0)).toThrow();
      expect(getTailscalePublishedOrigin()).toBeUndefined();
    },
  );
});
