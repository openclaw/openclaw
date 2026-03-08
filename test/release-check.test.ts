import { describe, expect, it } from "vitest";
import {
  collectAppcastSparkleVersionErrors,
  collectDiscordNativeRoutingDistErrors,
} from "../scripts/release-check.ts";

function makeItem(shortVersion: string, sparkleVersion: string): string {
  return `<item><title>${shortVersion}</title><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><sparkle:version>${sparkleVersion}</sparkle:version></item>`;
}

describe("collectAppcastSparkleVersionErrors", () => {
  it("accepts legacy 9-digit calver builds before lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.2.26", "202602260")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });

  it("requires lane-floor builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "202603010")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.3.1' has sparkle:version 202603010 below lane floor 2026030190.",
    ]);
  });

  it("accepts canonical stable lane builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "2026030190")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });
});

describe("collectDiscordNativeRoutingDistErrors", () => {
  it("flags stale startup-config routing and empty-string fallback bundles", () => {
    const errors = collectDiscordNativeRoutingDistErrors([
      {
        path: "/repo/dist/plugin-sdk/reply-old.js",
        content: `
          const route = resolveAgentRoute({
            cfg,
            channel: "discord",
            accountId,
          });
          const threadBinding = isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : void 0;
          const configuredRoute = threadBinding == null ? resolveConfiguredAcpRoute({
            cfg,
            route,
            channel: "discord",
            accountId,
          }) : null;
          if (configuredBinding) {
            await ensureConfiguredAcpRouteReady({
              cfg,
              configuredBinding
            });
          }
          const configuredBoundSessionKey = configuredRoute?.boundSessionKey ?? "";
          const boundSessionKey = threadBinding?.targetSessionKey?.trim() || configuredBoundSessionKey;
        `,
      },
    ]);

    expect(errors).toEqual([
      "dist/plugin-sdk/reply-old.js: Discord native command bundle still resolves bound routes from startup cfg instead of loadConfig().",
      "dist/plugin-sdk/reply-old.js: Discord native command bundle still treats empty configured bound-session keys as real targets.",
    ]);
  });

  it("accepts bundles that reload config and drop empty configured session keys", () => {
    const errors = collectDiscordNativeRoutingDistErrors([
      {
        path: "/repo/dist/plugin-sdk/reply-new.js",
        content: `
          const freshCfg = loadConfig();
          const route = resolveAgentRoute({
            cfg: freshCfg,
            channel: "discord",
            accountId,
          });
          const threadBinding = isThreadChannel ? threadBindings.getByThreadId(rawChannelId) : void 0;
          const configuredRoute = threadBinding == null ? resolveConfiguredAcpRoute({
            cfg: freshCfg,
            route,
            channel: "discord",
            accountId,
          }) : null;
          if (configuredBinding) {
            await ensureConfiguredAcpRouteReady({
              cfg: freshCfg,
              configuredBinding
            });
          }
          const configuredBoundSessionKey = configuredRoute?.boundSessionKey ?? "";
          const boundSessionKey =
            threadBinding?.targetSessionKey?.trim() || configuredBoundSessionKey || void 0;
        `,
      },
    ]);

    expect(errors).toEqual([]);
  });
});
