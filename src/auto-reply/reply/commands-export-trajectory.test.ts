import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const hoisted = vi.hoisted(() => ({
  resolveDefaultSessionStorePathMock: vi.fn(() => "/tmp/target-store/sessions.json"),
  resolveSessionFilePathMock: vi.fn(() => "/tmp/target-store/session.jsonl"),
  resolveSessionFilePathOptionsMock: vi.fn(
    (params: { agentId: string; storePath: string }) => params,
  ),
  loadSessionStoreMock: vi.fn(() => ({
    "agent:target:session": {
      sessionId: "session-1",
      updatedAt: 1,
    },
  })),
  exportTrajectoryBundleMock: vi.fn(() => ({
    outputDir: "/tmp/workspace/.openclaw/trajectory-exports/openclaw-trajectory-session",
    manifest: {
      eventCount: 7,
      runtimeEventCount: 3,
      transcriptEventCount: 4,
    },
    events: [{ type: "context.compiled" }],
    runtimeFile: "/tmp/target-store/session.trajectory.jsonl",
    supplementalFiles: ["metadata.json", "artifacts.json", "prompts.json"],
  })),
  resolveDefaultTrajectoryExportDirMock: vi.fn(
    () => "/tmp/workspace/.openclaw/trajectory-exports/openclaw-trajectory-session",
  ),
  existsSyncMock: vi.fn(() => true),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveDefaultSessionStorePath: hoisted.resolveDefaultSessionStorePathMock,
  resolveSessionFilePath: hoisted.resolveSessionFilePathMock,
  resolveSessionFilePathOptions: hoisted.resolveSessionFilePathOptionsMock,
}));

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: hoisted.loadSessionStoreMock,
}));

vi.mock("../../trajectory/export.js", () => ({
  exportTrajectoryBundle: hoisted.exportTrajectoryBundleMock,
  resolveDefaultTrajectoryExportDir: hoisted.resolveDefaultTrajectoryExportDirMock,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mockedFs = {
    ...actual,
    existsSync: hoisted.existsSyncMock,
  };
  return {
    ...mockedFs,
    default: mockedFs,
  };
});

function makeParams(): HandleCommandsParams {
  return {
    cfg: {},
    ctx: {
      SessionKey: "agent:main:slash-session",
    },
    command: {
      commandBodyNormalized: "/export-trajectory",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "sender-1",
      channel: "quietchat",
      surface: "quietchat",
      ownerList: [],
      rawBodyNormalized: "/export-trajectory",
    },
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: 1,
    },
    sessionKey: "agent:target:session",
    workspaceDir: "/tmp/workspace",
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("buildExportTrajectoryReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.existsSyncMock.mockReturnValue(true);
  });

  it("builds a trajectory bundle from the target session", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");

    const reply = await buildExportTrajectoryReply(makeParams());

    expect(reply.text).toContain("✅ Trajectory exported!");
    expect(hoisted.resolveDefaultSessionStorePathMock).toHaveBeenCalledWith("target");
    expect(hoisted.exportTrajectoryBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:target:session",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("keeps user-named output paths inside the workspace trajectory export directory", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory my-bundle";

    await buildExportTrajectoryReply(params);

    expect(hoisted.exportTrajectoryBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: "/tmp/workspace/.openclaw/trajectory-exports/my-bundle",
      }),
    );
  });

  it("rejects absolute output paths", async () => {
    const { buildExportTrajectoryReply } = await import("./commands-export-trajectory.js");
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-trajectory /tmp/outside";

    const reply = await buildExportTrajectoryReply(params);

    expect(reply.text).toContain("Failed to resolve output path");
    expect(hoisted.exportTrajectoryBundleMock).not.toHaveBeenCalled();
  });
});
