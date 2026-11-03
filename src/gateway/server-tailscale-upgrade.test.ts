import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGatewayStartupOperations } from "../cli/gateway-cli/run-loop-startup.js";
import { captureEnv } from "../test-utils/env.js";
import { startGatewayTailscaleExposure } from "./server-tailscale.js";
import { getTailscalePublishedOrigin } from "./tailscale-published-origin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("managed Tailscale upgrade", () => {
  const legacyRoute = (funnel = false, proxyPort = 18789) => {
    const host = "fixture.tailnet.ts.net:443";
    return {
      TCP: { "443": { HTTPS: true } },
      Web: { [host]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${proxyPort}/` } } } },
      ...(funnel ? { AllowFunnel: { [host]: true } } : {}),
    };
  };

  const installFixture = async (config: object, mode: "serve" | "funnel") => {
    const fixture = fileURLToPath(
      new URL("../../test/fixtures/tailscale-legacy-route-fixture.mjs", import.meta.url),
    );
    const marker = path.join(tempDirs.make("openclaw-tailscale-upgrade-"), "state");
    await writeFile(marker, JSON.stringify(config));
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = fixture;
    process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER = marker;
    process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE = mode;
    process.env.VITEST ??= "true";
    return marker;
  };

  it.each([
    ["serve", 443],
    ["serve", 18789],
    ["funnel", 19001],
  ] as const)("adopts a predecessor %s route to Gateway port %s", async (mode, port) => {
    const env = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
      "VITEST",
    ]);
    const marker = await installFixture(legacyRoute(mode === "funnel", port), mode);
    const info = vi.fn();
    let cleanup: (() => Promise<void>) | null = null;
    try {
      cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: mode,
        port,
        backend: { host: "127.0.0.1", port: 19000 },
        logTailscale: { info, warn: () => undefined },
      });
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({});
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining("adopted from a previous OpenClaw release"),
      );
    } finally {
      await cleanup?.();
      env.restore();
    }
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
          "old.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:18789/" } },
          },
        },
      },
    ],
    [
      "foreign sibling path",
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "fixture.tailnet.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:18789/" },
              "/other": { Proxy: "http://127.0.0.1:8096/" },
            },
          },
        },
      },
    ],
  ])("does not modify a %s", async (_label, config, recovery = /--https=443 --set-path=\/ off/) => {
    const env = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
      "VITEST",
    ]);
    const marker = await installFixture(config, "serve");
    const before = await readFile(marker, "utf8");
    const exposure = startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      backend: { host: "127.0.0.1", port: 19000 },
      logTailscale: { info: () => undefined, warn: () => undefined },
    });
    try {
      await expect(exposure).rejects.toThrow(recovery);
      expect(await readFile(marker, "utf8")).toBe(before);
    } finally {
      await exposure.then(
        (cleanup) => cleanup?.(),
        () => undefined,
      );
      env.restore();
    }
  });

  it("does not mutate an independent Tailscale Service", async () => {
    const env = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
      "VITEST",
    ]);
    const marker = await installFixture({ Services: { "svc:other": legacyRoute() } }, "serve");
    const before = await readFile(marker, "utf8");

    try {
      const cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        backend: { host: "127.0.0.1", port: 19000 },
        logTailscale: { info: () => undefined, warn: () => undefined },
      });

      expect(await readFile(marker, "utf8")).toBe(before);
      await cleanup?.();
    } finally {
      env.restore();
    }
  });

  it.each(["serve", "funnel"] as const)(
    "reclaims %s after the foreground process exits without restarting its Gateway owner",
    async (mode) => {
      const env = captureEnv([
        "OPENCLAW_TEST_TAILSCALE_BINARY",
        "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
        "OPENCLAW_TEST_TAILSCALE_FIXTURE_MODE",
        "OPENCLAW_TEST_TAILSCALE_FIXTURE_CLAIMS",
        "VITEST",
        "PATH",
      ]);
      let cleanup: (() => Promise<void>) | null = null;
      try {
        const marker = await installFixture({}, mode);
        await symlink(
          process.env.OPENCLAW_TEST_TAILSCALE_BINARY!,
          path.join(path.dirname(marker), "tailscale"),
        );
        process.env.PATH = `${path.dirname(marker)}${path.delimiter}${process.env.PATH ?? ""}`;
        const claimsPath = path.join(path.dirname(marker), "claims.jsonl");
        process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_CLAIMS = claimsPath;
        const readClaims = async () =>
          (await readFile(claimsPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { pid: number; target: string });
        const gatewayPid = process.pid;
        const startup = createGatewayStartupOperations();
        await startup.run(
          async (signal) =>
            (cleanup = await startGatewayTailscaleExposure({
              tailscaleMode: mode,
              port: 18789,
              backend: { host: "127.0.0.1", port: 19000 },
              logTailscale: { info: vi.fn(), warn: () => undefined },
              signal,
            })),
        );
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
        const release = cleanup as (() => Promise<void>) | null;
        cleanup = null;
        await release?.();
        expect(() => process.kill(replacement.pid, 0)).toThrow();
        expect(getTailscalePublishedOrigin()).toBeUndefined();
      } finally {
        await (cleanup as (() => Promise<void>) | null)?.();
        env.restore();
      }
    },
  );
});
