import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  attachmentParams,
  prepareAttachmentFixture,
} from "./chat-send-attachments.test-support.js";

const mocks = vi.hoisted(() => ({
  ensureSandboxWorkspaceForSession: vi.fn(),
  stageSandboxMedia: vi.fn(),
  resolveReusableWorkspaceSkillSnapshot: vi.fn(),
}));
vi.mock("../../agents/sandbox/context.js", () => ({
  ensureSandboxWorkspaceForSession: mocks.ensureSandboxWorkspaceForSession,
}));
vi.mock("../../auto-reply/reply/stage-sandbox-media.js", () => ({
  SANDBOX_MEDIA_MAX_BYTES: 20 * 1024 * 1024,
  stageSandboxMedia: mocks.stageSandboxMedia,
}));
vi.mock("../../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: mocks.resolveReusableWorkspaceSkillSnapshot,
}));

it.each(["existing", "admitted new"] as const)(
  "uses %s session's private skill identity for both pre-ACK staging calls",
  async (sessionKind) => {
    await withOpenClawTestState({ label: "private-preack-stage" }, async (state) => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const selection = {
        skillId: "00000000-0000-0000-0000-000000000001",
        revision: "0".repeat(64),
        name: "private-proof",
        ownerProfileId: "private-profile",
      };
      const snapshot = { prompt: "", skills: [], librarySelections: [selection] };
      mocks.resolveReusableWorkspaceSkillSnapshot.mockReset().mockResolvedValue({ snapshot });
      mocks.ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue({
        workspaceDir: state.path("isolated-runtime"),
      });
      mocks.stageSandboxMedia.mockReset().mockImplementation(async ({ ctx }) => {
        ctx.media[0].path = "media/inbound/private.txt";
        return { staged: new Map([[0, "media/inbound/private.txt"]]) };
      });
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            sandbox: { mode: "all" as const, backend: "ssh" as const },
          },
        },
      };
      const entry = {
        skillLibrarySelections: [selection],
        spawnedCwd: state.path("session-workspace"),
      };
      const staleEntry = {
        skillLibrarySelections: [{ ...selection, revision: "1".repeat(64) }],
      };
      const { result } = await prepareAttachmentFixture({
        params: attachmentParams(`private-${sessionKind}`, "private.txt", "private input", {
          sessionKey: "agent:main:private",
          message: "read this",
        }),
        session: {
          cfg,
          entry: sessionKind === "existing" ? staleEntry : undefined,
        },
        admission: {
          initialSessionEntry: sessionKind === "admitted new" ? entry : undefined,
          admittedSessionEntry: sessionKind === "existing" ? entry : undefined,
        },
        context: {},
      });
      assert(result.ok, "private skill attachment preparation failed");
      expect(mocks.resolveReusableWorkspaceSkillSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          librarySelections: [selection],
          workspaceDir: state.workspaceDir,
        }),
      );
      expect(mocks.ensureSandboxWorkspaceForSession).toHaveBeenCalledWith(
        expect.objectContaining({
          skillsSnapshot: snapshot,
          workspaceDir: state.path("session-workspace"),
        }),
      );
      expect(mocks.stageSandboxMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          skillsSnapshot: snapshot,
          workspaceDir: state.path("session-workspace"),
        }),
      );
      expect(result.value.mediaPathOffloads[0]).toMatchObject({
        path: "media/inbound/private.txt",
        workspaceDir: state.path("isolated-runtime"),
      });
    });
  },
);
