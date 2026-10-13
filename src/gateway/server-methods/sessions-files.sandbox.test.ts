import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { withSessionTranscriptDeltaReader } from "../../config/sessions/session-transcript-delta-read.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readDelta: vi.fn(),
  showsPlannedBind: vi.fn(),
}));

// The live-container check needs Docker; each test states what the container shows.
vi.mock("../../agents/sandbox/mount-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sandbox/mount-plan.js")>()),
  prepareSandboxMountPlan: async () => ({
    binds: [],
    skippedBinds: [],
    readOnlyWorkspaceSkillMounts: [],
    tmpfs: [],
  }),
  sandboxContainerShowsPlannedBind: hoisted.showsPlannedBind,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadSessionEntry: hoisted.loadSessionEntry,
  loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
}));

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    hoisted.loadSessionEntry(params.key, { agentId: params.agentId }),
}));

// mock-isolation: File-policy tests supply visible transcript pages without opening SQLite.
vi.mock("../../config/sessions/session-transcript-delta-read.js", () => ({
  withSessionTranscriptDeltaReader: ((scope, consume) =>
    consume({
      visible: async (limits) => hoisted.readDelta(scope, limits),
      raw: async () => {
        throw new Error("File browsing must consume visible transcript pages");
      },
    })) satisfies typeof withSessionTranscriptDeltaReader,
}));

const sessionKey = "agent:main:main";
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const getFile = (filePath: string) => invoke("sessions.files.get", { sessionKey, path: filePath });
const saveFile = (params: Record<string, unknown>) =>
  invoke("sessions.files.set", { sessionKey, ...params });
const mockVisibleMessages = createVisibleMessagesMock(hoisted.readDelta);

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
  hoisted.showsPlannedBind.mockResolvedValue(true);
});

afterEach(() => {
  removeWorkspaceFixture(workspaceRoot);
});

describe("sessions.files sandbox container paths", () => {
  it.each([
    { workspaceAccess: "rw", link: "/workspace/ui/vite.config.ts", opens: true },
    { workspaceAccess: "ro", link: "/agent/ui/vite.config.ts", opens: true },
    // The container workspace is a separate sandbox copy, outside the session workspace.
    { workspaceAccess: "none", link: "/workspace/ui/vite.config.ts", opens: false },
  ] as const)(
    "resolves a sandboxed agent's $link link through its $workspaceAccess mount",
    async ({ workspaceAccess, link, opens }) => {
      const session = hoisted.loadSessionEntry() as Record<string, unknown>;
      hoisted.loadSessionEntry.mockReturnValue({
        ...session,
        cfg: { agents: { defaults: { sandbox: { mode: "all", workspaceAccess } } } },
      });

      const result = await getFile(link);

      if (opens) {
        expect(expectOkPayload(result).file).toMatchObject({
          content: "export default {};\n",
          missing: false,
          path: "ui/vite.config.ts",
        });
      } else {
        expect(expectError(result).details).toMatchObject({
          type: "session_file_not_found",
          reason: "outside_session_boundary",
        });
      }
    },
  );

  it("saves a sandboxed agent's /workspace link and keeps in-root host paths unmapped", async () => {
    const session = hoisted.loadSessionEntry() as Record<string, unknown>;
    hoisted.loadSessionEntry.mockReturnValue({
      ...session,
      cfg: { agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } } },
    });
    const link = "/workspace/ui/vite.config.ts";
    const preview = expectOkPayload(await getFile(link));

    const next = "export default { sandbox: true };\n";
    expectOkPayload(await saveFile({ path: link, content: next, expectedHash: preview.file.hash }));
    expect(fs.readFileSync(path.join(workspaceRoot, "ui", "vite.config.ts"), "utf8")).toBe(next);

    const hostPath = path.join(workspaceRoot, "ui", "vite.config.ts");
    expect(expectOkPayload(await getFile(hostPath)).file).toMatchObject({
      content: next,
      path: "ui/vite.config.ts",
    });
  });
  it.each([
    { name: "hidden by container-only storage", shows: async () => false },
    {
      name: "unverifiable without a running container",
      shows: async () => {
        throw new Error("No such container");
      },
    },
  ])("refuses links whose backing is $name", async ({ shows }) => {
    hoisted.showsPlannedBind.mockImplementation(shows);
    const session = hoisted.loadSessionEntry() as Record<string, unknown>;
    hoisted.loadSessionEntry.mockReturnValue({
      ...session,
      cfg: { agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } } },
    });
    const hidden = path.join(workspaceRoot, "ui", "vite.config.ts");
    const original = fs.readFileSync(hidden, "utf8");
    const link = "/workspace/ui/vite.config.ts";

    expect(expectError(await getFile(link)).details).toMatchObject({
      reason: "outside_session_boundary",
    });
    expectError(await saveFile({ path: link, content: "changed", expectedHash: "unused" }));
    expect(fs.readFileSync(hidden, "utf8")).toBe(original);
    expect(hoisted.showsPlannedBind).toHaveBeenCalledWith(
      expect.objectContaining({ target: link }),
    );
  });
});
