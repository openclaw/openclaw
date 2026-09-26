import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { DraftRestoredFolderValidation } from "./folder-validation.ts";

function fixture(error: GatewayRequestError) {
  const client = createTestGatewayClient(async () => {
    throw error;
  });
  const callbacks = {
    onApprovedRootsChange: vi.fn(),
    onVerified: vi.fn(),
    onMissing: vi.fn(),
    onFailed: vi.fn(),
  };
  const validation = new DraftRestoredFolderValidation(
    () => ({
      gateway: {
        client,
        phase: "connected",
        offlineStable: false,
        hello: null,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: null,
        sessionKey: "",
        lastError: null,
        lastErrorCode: null,
      },
      folder: "/saved/project",
      selectedByUser: false,
      isAdmin: true,
    }),
    callbacks,
  );
  validation.validate("/saved/project");
  return { validation, callbacks };
}

describe("restored new-session folder validation", () => {
  it("retains approved roots on cancellation and clears them at a draft boundary", () => {
    let isAdmin = false;
    const onApprovedRootsChange = vi.fn();
    const validation = new DraftRestoredFolderValidation(
      () => ({ gateway: undefined, folder: "/workspace", selectedByUser: false, isAdmin }),
      { onApprovedRootsChange, onVerified: vi.fn(), onMissing: vi.fn(), onFailed: vi.fn() },
    );
    const listing = { path: "/approved/project", parent: "/approved", home: "/home", entries: [] };
    validation.recordApprovedListing(listing);
    validation.recordApprovedListing(listing);
    expect(onApprovedRootsChange).toHaveBeenCalledOnce();
    expect(validation.knownWorkspaceRoots("/workspace")).toEqual([
      "/workspace",
      "/approved/project",
      "/approved",
    ]);
    validation.cancel();
    expect(validation.knownWorkspaceRoots("")).toEqual(["/approved/project", "/approved"]);
    isAdmin = true;
    validation.recordApprovedListing({ ...listing, path: "/admin-only", parent: undefined });
    expect(onApprovedRootsChange).toHaveBeenCalledOnce();
    expect(validation.knownWorkspaceRoots("")).not.toContain("/admin-only");
    validation.reset();
    expect(validation.knownWorkspaceRoots("/workspace")).toEqual(["/workspace"]);
  });

  it.each(["ENOENT: no such file or directory", "Error: ENOTDIR: not a directory"])(
    "restores a missing folder and unblocks submission after %s",
    async (message) => {
      const { validation, callbacks } = fixture(
        new GatewayRequestError({ code: "INVALID_REQUEST", message }),
      );
      expect(validation.blocked).toBe(true);
      await vi.waitFor(() => expect(callbacks.onMissing).toHaveBeenCalledOnce());
      expect(validation.blocked).toBe(false);
      expect(callbacks.onFailed).not.toHaveBeenCalled();
    },
  );

  it.each([
    { code: "UNAVAILABLE", message: "gateway restarting" },
    { code: "INVALID_REQUEST", message: "EACCES: permission denied" },
    {
      code: "INVALID_REQUEST",
      message: "Error: EACCES: permission denied, scandir '/work/: ENOENT:/project'",
    },
  ])("retains the folder and reports a recoverable failure after $message", async (error) => {
    const { validation, callbacks } = fixture(new GatewayRequestError(error));
    await vi.waitFor(() => expect(callbacks.onFailed).toHaveBeenCalledOnce());
    expect(validation.blocked).toBe(true);
    expect(callbacks.onMissing).not.toHaveBeenCalled();
  });
});
