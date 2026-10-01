import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";

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
      const request = normalizeChatSendRequest({
        client: null,
        params: {
          sessionKey: "agent:main:private",
          message: "read this",
          idempotencyKey: `private-${sessionKind}`,
          attachments: [
            {
              fileName: "private.txt",
              mimeType: "text/plain",
              content: Buffer.from("private input").toString("base64"),
            },
          ],
        },
      });
      expect(request.ok).toBe(true);
      if (!request.ok) {
        throw new Error(request.error);
      }
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            sandbox: { mode: "all" as const, backend: "ssh" as const },
          },
        },
      };
      const entry = { skillLibrarySelections: [selection] };
      const staleEntry = {
        skillLibrarySelections: [{ ...selection, revision: "1".repeat(64) }],
      };
      const controller = new AbortController();
      const result = await prepareChatSendAttachments({
        request: request.value,
        session: {
          cfg,
          sessionKey: "agent:main:private",
          agentId: "main",
          entry: sessionKind === "existing" ? staleEntry : undefined,
          resolvedSessionModel: { provider: "fixture", model: "fixture" },
          clientRunId: `private-${sessionKind}`,
        },
        admission: {
          activeRunAbort: { controller },
          initialSessionEntry: sessionKind === "admitted new" ? entry : undefined,
          admittedSessionEntry: sessionKind === "existing" ? entry : undefined,
          assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
          cleanupAdmittedRun() {},
        },
        context: {},
        respond: vi.fn(),
      } as unknown as Parameters<typeof prepareChatSendAttachments>[0]);
      expect(result.ok).toBe(true);
      expect(mocks.resolveReusableWorkspaceSkillSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ librarySelections: [selection] }),
      );
      expect(mocks.ensureSandboxWorkspaceForSession).toHaveBeenCalledWith(
        expect.objectContaining({ skillsSnapshot: snapshot }),
      );
      expect(mocks.stageSandboxMedia).toHaveBeenCalledWith(
        expect.objectContaining({ skillsSnapshot: snapshot }),
      );
      if (result.ok) {
        expect(result.value.mediaPathOffloads[0]).toMatchObject({
          path: "media/inbound/private.txt",
          workspaceDir: state.path("isolated-runtime"),
        });
      }
    });
  },
);
