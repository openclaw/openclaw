/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("loads route subtitles with command-palette search", async () => {
  const { en, manager } = await loadI18n({ subtitles: { appearance: "Darstellung" } });
  const subtitles = en.subtitles;
  expect(manager.t("subtitles.appearance")).toBe("subtitles.appearance");
  await manager.setLocale("de");

  const { getStaticCommandPaletteCatalogItems } =
    await import("../components/command-palette-catalog-search.ts");
  expect(getStaticCommandPaletteCatalogItems(true)).toContainEqual(
    expect.objectContaining({
      id: "settings-appearance",
      description: "Theme and UI settings.",
    }),
  );
  expect(en.subtitles).toBe(subtitles);
  expect(manager.t("subtitles.appearance")).toBe("Darstellung");
  expect(manager.t("subtitles.connection")).toBe(
    "Gateway endpoint, credentials, and handshake status.",
  );
});

it("loads executor-only copy when a slash command is executed", async () => {
  const { manager } = await loadI18n();
  expect(manager.t("chat.commandResults.unknownCommand")).toBe(
    "chat.commandResults.unknownCommand",
  );
  expect(manager.t("chat.commandResults.options")).toBe("chat.commandResults.options");
  expect(manager.t("chat.commandResults.sessionUnavailable")).toBe(
    "chat.commandResults.sessionUnavailable",
  );

  const { executeSlashCommand } = await import("../pages/chat/chat-command-executor.ts");
  const { createTestGatewayClient } = await import("../test-helpers/gateway-client.ts");
  const { createTestSessionCapability } =
    await import("../lib/sessions/session-capability.test-support.ts");
  const request = vi.fn();
  const client = createTestGatewayClient(request);
  const snapshot = { client, hello: null, phase: "connected" as const };
  const sessions = createTestSessionCapability({
    snapshot,
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  await expect(
    executeSlashCommand(client, "agent:main:main", "not-a-command", "", {
      sessions,
      sessionAccessSnapshot: snapshot,
    }),
  ).resolves.toEqual({ content: "Unknown command: `/not-a-command`" });
  expect(request).not.toHaveBeenCalled();
  expect(manager.t("chat.commandResults.options", { options: "brief, full" })).toBe(
    "Options: brief, full.",
  );
  expect(manager.t("chat.commandResults.sessionUnavailable")).toBe(
    "Session capability is unavailable",
  );
});
