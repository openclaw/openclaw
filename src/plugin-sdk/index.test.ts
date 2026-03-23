import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPluginSdkPackageExports } from "./entrypoints.js";

const pluginSdkSpecifiers = buildPluginSdkSpecifiers();
const hasBuiltPluginSdkDist = pluginSdkEntrypoints.every((entry) =>
  existsSync(path.join(process.cwd(), "dist", "plugin-sdk", `${entry}.js`)),
);

describe("plugin-sdk exports", () => {
  it("does not expose runtime modules", async () => {
    const runtimeExports = await collectRuntimeExports(path.join(import.meta.dirname, "index.ts"));
    const forbidden = [
      "chunkMarkdownText",
      "chunkText",
      "hasControlCommand",
      "isControlCommandMessage",
      "shouldComputeCommandAuthorized",
      "shouldHandleTextCommands",
      "buildMentionRegexes",
      "matchesMentionPatterns",
      "resolveStateDir",
      "writeConfigFile",
      "enqueueSystemEvent",
      "fetchRemoteMedia",
      "saveMediaBuffer",
      "formatAgentEnvelope",
      "buildPairingReply",
      "resolveAgentRoute",
      "dispatchReplyFromConfig",
      "createReplyDispatcherWithTyping",
      "dispatchReplyWithBufferedBlockDispatcher",
      "resolveCommandAuthorizedFromAuthorizers",
      "monitorSlackProvider",
      "monitorTelegramProvider",
      "monitorIMessageProvider",
      "monitorSignalProvider",
      "sendMessageSlack",
      "sendMessageTelegram",
      "sendMessageIMessage",
      "sendMessageSignal",
      "sendMessageWhatsApp",
      "probeSlack",
      "probeTelegram",
      "probeIMessage",
      "probeSignal",
    ];

    for (const key of forbidden) {
      expect(runtimeExports.has(key)).toBe(false);
    }
  });

  it("keeps the root runtime surface intentionally small", async () => {
    const runtimeExports = await collectRuntimeExports(path.join(import.meta.dirname, "index.ts"));
    expect([...runtimeExports].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "buildFalImageGenerationProvider",
      "buildGoogleImageGenerationProvider",
      "buildOpenAIImageGenerationProvider",
      "delegateCompactionToRuntime",
      "emptyPluginConfigSchema",
      "normalizePluginHttpPath",
      "registerPluginHttpRoute",
      "buildBaseAccountStatusSnapshot",
      "buildBaseChannelStatusSummary",
      "buildTokenChannelStatusSummary",
      "collectStatusIssuesFromLastError",
      "createDefaultChannelRuntimeState",
      "resolveChannelEntryMatch",
      "resolveChannelEntryMatchWithFallback",
      "normalizeChannelSlug",
      "buildChannelKeyCandidates",
    ]);

    for (const key of requiredFunctions) {
      expect(sdk).toHaveProperty(key);
      expect(typeof (sdk as Record<string, unknown>)[key]).toBe("function");
    }
  });

  // Verify critical constants that extensions depend on are exported.
  it("exports critical constants used by channel extensions", () => {
    const requiredConstants = [
      "DEFAULT_GROUP_HISTORY_LIMIT",
      "DEFAULT_ACCOUNT_ID",
      "SILENT_REPLY_TOKEN",
      "PAIRING_APPROVED_MESSAGE",
    ];

    for (const key of requiredConstants) {
      expect(sdk).toHaveProperty(key);
    }
  });

  // Use pre-built dist/plugin-sdk. The programmatic tsdown build hits Rolldown plugin
  // compatibility issues (BindingPluginOptions error). CI runs `pnpm build` before test.
  it.skipIf(!hasBuiltPluginSdkDist)(
    "emits importable bundled subpath entries",
    { timeout: 60_000 },
    async () => {
      const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-sdk-consumer-"));
      const repoDistDir = path.join(process.cwd(), "dist");

      try {
        for (const entry of pluginSdkEntrypoints) {
          const module = await import(
            pathToFileURL(path.join(repoDistDir, "plugin-sdk", `${entry}.js`)).href
          );
          expect(module).toBeTypeOf("object");
        }

        const packageDir = path.join(fixtureDir, "openclaw");
        const consumerDir = path.join(fixtureDir, "consumer");
        const consumerEntry = path.join(consumerDir, "import-plugin-sdk.mjs");

        await fs.mkdir(packageDir, { recursive: true });
        await fs.symlink(repoDistDir, path.join(packageDir, "dist"), "dir");
        await fs.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify(
            {
              exports: buildPluginSdkPackageExports(),
              name: "openclaw",
              type: "module",
            },
            null,
            2,
          ),
        );

        await fs.mkdir(path.join(consumerDir, "node_modules"), { recursive: true });
        await fs.symlink(packageDir, path.join(consumerDir, "node_modules", "openclaw"), "dir");
        await fs.writeFile(
          consumerEntry,
          [
            `const specifiers = ${JSON.stringify(pluginSdkSpecifiers)};`,
            "const results = {};",
            "for (const specifier of specifiers) {",
            "  results[specifier] = typeof (await import(specifier));",
            "}",
            "export default results;",
          ].join("\n"),
        );

        const { default: importResults } = await import(pathToFileURL(consumerEntry).href);
        expect(importResults).toEqual(
          Object.fromEntries(pluginSdkSpecifiers.map((specifier) => [specifier, "object"])),
        );
      } finally {
        await fs.rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps package.json plugin-sdk exports synced with the manifest", async () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const currentPluginSdkExports = Object.fromEntries(
      Object.entries(packageJson.exports ?? {}).filter(([key]) => key.startsWith("./plugin-sdk")),
    );

    expect(currentPluginSdkExports).toEqual(buildPluginSdkPackageExports());
  });
});
