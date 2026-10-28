import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  attachmentParams,
  prepareAttachmentFixture,
} from "./chat-send-attachments.test-support.js";

const { sandbox, media, skills } = vi.hoisted(() => ({
  sandbox: { prepareSandboxWorkspaceForSession: vi.fn() },
  media: { SANDBOX_MEDIA_MAX_BYTES: 20 * 1024 * 1024, stageSandboxMedia: vi.fn() },
  skills: { resolveReusableWorkspaceSkillSnapshot: vi.fn() },
}));
// mock-isolation: Observe sandbox identity selection without provisioning a real sandbox.
vi.mock("../../agents/sandbox/context.js", () => sandbox);
// mock-isolation: Record the pre-ACK media context without copying real sandbox files.
vi.mock("../../auto-reply/reply/stage-sandbox-media.js", () => media);
// mock-isolation: Supply private skill selections without querying the operator skill store.
vi.mock("../../skills/runtime/session-snapshot.js", () => skills);

it.each(["existing", "admitted new"] as const)(
  "uses %s session's private skill identity for both pre-ACK staging calls",
  (sessionKind) =>
    withOpenClawTestState({ label: "private-preack-stage" }, async (state) => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const selection = {
        skillId: "00000000-0000-0000-0000-000000000001",
        revision: "0".repeat(64),
        name: "private-proof",
        ownerProfileId: "private-profile",
      };
      const snapshot = { prompt: "", skills: [], librarySelections: [selection] };
      skills.resolveReusableWorkspaceSkillSnapshot.mockReset().mockResolvedValue({ snapshot });
      sandbox.prepareSandboxWorkspaceForSession.mockReset().mockResolvedValue({
        workspace: { workspaceDir: state.path("isolated-runtime") },
        assertCurrent() {},
        [Symbol.dispose]() {},
      });
      media.stageSandboxMedia.mockReset().mockImplementation(async ({ ctx }) => {
        ctx.media[0].path = "media/inbound/private.txt";
        return { staged: new Map([[0, "media/inbound/private.txt"]]) };
      });
      const defaults = {
        workspace: state.workspaceDir,
        sandbox: { mode: "all" as const, backend: "ssh" as const },
      };
      const workspaceDir = state.path("session-workspace");
      const entry = {
        skillLibrarySelections: [selection],
        spawnedCwd: workspaceDir,
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
          cfg: { agents: { defaults } },
          entry: sessionKind === "existing" ? staleEntry : undefined,
        },
        admission: {
          initialSessionEntry: sessionKind === "admitted new" ? entry : undefined,
          admittedSessionEntry: sessionKind === "existing" ? entry : undefined,
        },
        context: {},
      });
      assert(result.ok, "private skill attachment preparation failed");
      expect(skills.resolveReusableWorkspaceSkillSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          librarySelections: [selection],
          workspaceDir: state.workspaceDir,
        }),
      );
      for (const stage of [sandbox.prepareSandboxWorkspaceForSession, media.stageSandboxMedia]) {
        expect(stage).toHaveBeenCalledWith(
          expect.objectContaining({ skillsSnapshot: snapshot, workspaceDir }),
        );
      }
      expect(result.value.mediaPathOffloads[0]).toMatchObject({
        path: "media/inbound/private.txt",
        workspaceDir: state.path("isolated-runtime"),
      });
    }),
);
