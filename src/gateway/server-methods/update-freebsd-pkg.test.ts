import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayLockPayload from "../../infra/gateway-lock-payload.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import * as exec from "../../process/exec.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import {
  adoptUpdateCampaignMock,
  captureUpdateRunPayload,
  detectRespawnSupervisorMock,
  mockGlobalInstallSurface,
  resolveUpdateInstallSurfaceMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const sqliteHostPlatform = process.platform;
const existingHostUri = nodeSqlite.resolveExistingSqliteFileUri;
const immutableHostUri = nodeSqlite.resolveImmutableSqliteFileUri;

beforeEach(() => {
  // Platform simulation must not change the real process identity shared with SQLite workers.
  const namespace = gatewayLockPayload.readGatewayLockProcessNamespace();
  vi.spyOn(gatewayLockPayload, "readGatewayLockProcessNamespace").mockReturnValue(namespace);
});

afterEach(() => vi.restoreAllMocks());

describe("system package RPC admission", () => {
  it.each([
    { ownership: "owned", managed: false, platform: "linux", manager: "pacman" },
    { ownership: "owned", managed: false, platform: "freebsd", manager: "pkg" },
    { ownership: "owned", managed: true, platform: "freebsd", manager: "pkg" },
    { ownership: "unknown", managed: false, platform: "freebsd", manager: "pkg" },
    { ownership: "unknown", managed: true, platform: "freebsd", manager: "pkg" },
  ] as const)(
    "refuses $ownership pkg ownership before campaign or handoff (managed=$managed)",
    async ({ ownership, managed, platform, manager }) => {
      mockGlobalInstallSurface();
      detectRespawnSupervisorMock.mockReturnValue(managed ? "systemd" : null);
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockResolvedValue(
          pkgQueryResult(
            ownership === "owned" ? "/tmp/openclaw-global/package.json\n" : "",
            ownership === "unknown" ? { code: 1 } : {},
          ),
        );
      await withMockedPlatform(platform, async () => {
        const response = expectDefined(await captureUpdateRunPayload(), "update response");
        const reason = `${manager}-${ownership === "owned" ? "owned-install" : "ownership-unavailable"}`;
        expect(response).toMatchObject({
          ok: false,
          message: expect.stringContaining(
            ownership === "owned"
              ? manager === "pkg"
                ? "Update it through pkg"
                : "pacman -Syu"
              : "Restore access to the active pkg database",
          ),
          result: { status: ownership === "owned" ? "skipped" : "error", reason },
          restart: null,
        });
        expect(getUpdateRun(response.runId)).toMatchObject({
          status: ownership === "owned" ? "skipped" : "failed",
          reason,
          origin: { nextAction: response.message },
        });
      });
      expect(query).toHaveBeenCalledOnce();
      expect(resolveUpdateInstallSurfaceMock).not.toHaveBeenCalled();
      expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    },
  );

  it.each(["darwin", "win32"] as const)(
    "preserves %s update admission without a pkg query",
    async (platform) => {
      // Platform simulation does not change the real ledger's SQLite VFS.
      vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((file) =>
        existingHostUri(file, sqliteHostPlatform),
      );
      vi.spyOn(nodeSqlite, "resolveImmutableSqliteFileUri").mockImplementation((file) =>
        immutableHostUri(file, sqliteHostPlatform),
      );
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockRejectedValue(new Error("unexpected pkg query"));
      await withMockedPlatform(platform, async () => {
        await expect(captureUpdateRunPayload()).resolves.toMatchObject({ ok: true });
      });
      expect(query).not.toHaveBeenCalled();
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    },
  );
});
