import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import * as exec from "../../process/exec.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import {
  adoptUpdateCampaignMock,
  captureUpdateRunPayload,
  detectRespawnSupervisorMock,
  invokeUpdateRun,
  mockGlobalInstallSurface,
  resolveUpdateInstallSurfaceMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const sqliteHostPlatform = process.platform;
const existingHostUri = nodeSqlite.resolveExistingSqliteFileUri;
const immutableHostUri = nodeSqlite.resolveImmutableSqliteFileUri;

afterEach(() => vi.restoreAllMocks());

describe("FreeBSD pkg RPC admission", () => {
  it.each([
    { ownership: "owned", managed: false },
    { ownership: "owned", managed: true },
    { ownership: "unknown", managed: false },
    { ownership: "unknown", managed: true },
  ])(
    "refuses $ownership pkg ownership before campaign or handoff (managed=$managed)",
    async ({ ownership, managed }) => {
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
      await withMockedPlatform("freebsd", async () => {
        const response = expectDefined(await captureUpdateRunPayload(), "update response");
        const reason = ownership === "owned" ? "pkg-owned-install" : "pkg-ownership-unavailable";
        expect(response).toMatchObject({
          ok: false,
          message: expect.stringContaining(
            ownership === "owned"
              ? "Update it through pkg"
              : "Restore access to the active pkg database",
          ),
          result: { status: "error", reason },
          restart: null,
        });
        expect(getUpdateRun(response.runId)).toMatchObject({
          status: "failed",
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

  it.each(["EACCES", "PRIVATE_CUSTOM_CODE"])(
    "keeps a caught pkg query cause private in RPC warnings (%s)",
    async (code) => {
      mockGlobalInstallSurface();
      const cause = Object.assign(new Error("/private/fixture/database token=fixture-secret"), {
        code,
      });
      const query = vi.spyOn(exec, "runCommandBuffered").mockRejectedValue(cause);
      const warn = vi.fn();
      const respond = vi.fn();
      await withMockedPlatform("freebsd", async () => {
        await invokeUpdateRun({}, respond, undefined, { logGateway: { warn, info: vi.fn() } });
      });
      const prefix = `FreeBSD pkg inspection failed during pkg query${code === "EACCES" ? " (EACCES)" : ""}.`;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: false,
          message: expect.stringContaining(prefix),
          result: expect.objectContaining({
            status: "error",
            reason: "pkg-ownership-unavailable",
          }),
          restart: null,
        }),
        undefined,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`update.run failed error=${prefix}`),
      );
      expect(JSON.stringify([respond.mock.calls, warn.mock.calls])).not.toMatch(
        /\/private\/fixture|fixture-secret|PRIVATE_CUSTOM_CODE/u,
      );
      expect(query).toHaveBeenCalledOnce();
      expect(resolveUpdateInstallSurfaceMock).not.toHaveBeenCalled();
      expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    },
  );

  it.each(["linux", "darwin", "win32"] as const)(
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
