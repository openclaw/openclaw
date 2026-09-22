/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import type { PluginInstallRequest } from "../../lib/plugins/index.ts";
import { confirmPluginInstall } from "./plugin-lifecycle-confirmation.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockResolvedValue(true);
});
afterEach(() => vi.resetAllMocks());

it.each([
  [{ source: "official", pluginId: "calendar" }, "calendar"],
  [{ source: "bundled", pluginId: "calendar" }, "calendar"],
  [{ source: "clawhub", packageName: "calendar" }, "calendar"],
  [{ source: "npm", spec: "@example/calendar@1.0.0" }, "@example/calendar@1.0.0"],
  [
    { source: "git", spec: "https://example.test/calendar.git" },
    "https://example.test/calendar.git",
  ],
  [{ source: "local", path: "/synthetic/calendar" }, "/synthetic/calendar"],
  [{ source: "npm-pack", archivePath: "/synthetic/calendar.tgz" }, "/synthetic/calendar.tgz"],
  [{ source: "marketplace", marketplace: "community", plugin: "calendar" }, "community:calendar"],
] satisfies Array<[PluginInstallRequest, string]>)(
  "identifies the actual install target before confirming %j",
  async (request, name) => {
    await expect(confirmPluginInstall(request)).resolves.toBe(true);
    expect(showConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `Install ${name}?`,
        confirmLabel: "Install",
      }),
    );
  },
);
