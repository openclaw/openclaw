import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { STAGED_INPUT_GITIGNORE } from "../../media/staged-inputs.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { resolveMediaGenerateToolContext } from "./media-generate-background.js";
import { buildMediaGenerateToolExecutionResult } from "./media-generate-result-shared.js";
import { loadMediaToolReferences } from "./media-tool-shared.js";

const { resolveSandboxContext } = vi.hoisted(() => ({
  resolveSandboxContext: vi.fn<typeof import("../sandbox/context.js").resolveSandboxContext>(),
}));
// mock-isolation: Provisioning stays synthetic so this test never opens real sandbox state.
vi.mock("../sandbox/context.js", () => ({ resolveSandboxContext }));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);

async function fixture() {
  const root = tempDirs.make("generated-media-result-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const mediaPath = path.join(root, "image.png");
  await fs.writeFile(mediaPath, png);
  const sandbox = { root: workspace, bridge: createHostSandboxFsBridge(workspace) };
  const acquireSandbox = async () => ({ ...sandbox, [Symbol.dispose]() {} });
  const params = {
    kind: "image" as const,
    result: { provider: "test", model: "test", attempts: [] },
    attachments: [{ type: "image" as const, path: mediaPath }],
    mediaUrls: [mediaPath],
    maxBytes: 1024,
    details: {},
  };
  return { root, workspace, mediaPath, sandbox, acquireSandbox, params };
}

describe("generated media sandbox access", () => {
  it("stages only the current outputs for follow-up references and retains delivery paths", async () => {
    const { root, workspace, mediaPath, sandbox, acquireSandbox, params } = await fixture();
    await fs.writeFile(path.join(root, "other-session.png"), png);
    const result = await buildMediaGenerateToolExecutionResult({
      ...params,
      sandbox: acquireSandbox,
    });
    const [relativePath] = result.details.sandboxPaths as string[];
    if (!relativePath) {
      throw new Error("Expected a sandbox path for the generated image");
    }

    expect(relativePath).toMatch(/^media\/inbound\/openclaw-staged-[^/]+\/image\.png$/);
    await expect(fs.readFile(path.join(workspace, relativePath))).resolves.toEqual(png);
    await expect(fs.readdir(path.dirname(path.join(workspace, relativePath)))).resolves.toEqual([
      ".gitignore",
      "image.png",
    ]);
    await expect(
      fs.readFile(path.join(workspace, path.dirname(relativePath), ".gitignore"), "utf8"),
    ).resolves.toBe(STAGED_INPUT_GITIGNORE);
    expect(result.attachments).toEqual(params.attachments);
    expect(result.details.paths).toEqual([mediaPath]);
    expect(result.contentText).toContain(`Sandbox file: "${relativePath}"`);
    expect(result.wakeResult).toBe(result.contentText);

    const references = await loadMediaToolReferences({
      inputs: [relativePath],
      toolName: "image_generate",
      expectedKind: "image",
      sandbox: { ...sandbox, workspaceOnly: true },
      maxBytes: 1024,
      mapMedia: (media) => media.buffer,
    });
    expect(references[0]?.source).toEqual(png);
  });

  it("leaves non-sandboxed results and remote-only video outputs unchanged", async () => {
    const { workspace, acquireSandbox, params } = await fixture();
    const result = await buildMediaGenerateToolExecutionResult(params);
    expect(result.details.sandboxPaths).toBeUndefined();
    expect(result.contentText).not.toContain("Sandbox");

    const url = "https://example.com/generated.mp4";
    const remote = await buildMediaGenerateToolExecutionResult({
      ...params,
      kind: "video",
      sandbox: acquireSandbox,
      attachments: [{ type: "video", url }],
      mediaUrls: [url],
    });
    expect(remote.details.paths).toEqual([url]);
    expect(remote.contentText).not.toContain("Sandbox");
    await expect(fs.readdir(workspace)).resolves.toEqual([]);
  });

  it.each(["size limit", "read-only workspace"])(
    "keeps delivery and reports unavailable copies on %s",
    async (failure) => {
      const { workspace, sandbox, acquireSandbox, params } = await fixture();
      if (failure === "read-only workspace") {
        vi.spyOn(sandbox.bridge, "createFileExclusive").mockRejectedValue(
          new Error("Sandbox path is read-only"),
        );
      }
      const result = await buildMediaGenerateToolExecutionResult({
        ...params,
        sandbox: acquireSandbox,
        maxBytes: failure === "size limit" ? 1 : params.maxBytes,
      });
      expect(result.attachments).toEqual(params.attachments);
      expect(result.details.paths).toEqual(params.mediaUrls);
      expect(result.details.sandboxPaths).toBeUndefined();
      expect(result.wakeResult).toContain("Sandbox copy unavailable:");
      await expect(fs.readdir(workspace)).resolves.toEqual([]);
    },
  );

  it.each([
    { requesterAgentId: "main", projectionClosed: true },
    { requesterAgentId: "work", projectionClosed: false },
    { requesterAgentId: "work", projectionClosed: true },
  ])(
    "reacquires the admitted policy owner for $requesterAgentId (projection closed: $projectionClosed) and rejects rerouting",
    async ({ requesterAgentId, projectionClosed }) => {
      const { workspace, sandbox, params } = await fixture();
      const originalWrite = vi.spyOn(sandbox.bridge, "createFileExclusive");
      if (projectionClosed) {
        originalWrite.mockRejectedValue(new Error("Originating projection has closed"));
      }
      const dispose = vi.fn();
      const skillsSnapshot = {
        prompt: "",
        skills: [],
        librarySelections: [
          {
            skillId: "00000000-0000-4000-8000-000000000001",
            revision: "a".repeat(64),
            name: "skill",
            ownerProfileId: "owner",
          },
        ],
      };
      const config = { agents: { entries: { main: {}, work: {} } } };
      setRuntimeConfigSnapshot(config);
      resolveSandboxContext.mockImplementation(async (selection) => {
        resolveSessionAgentIds({ ...selection, config });
        return createSandboxTestContext({
          overrides: {
            workspaceDir: workspace,
            fsBridge: createHostSandboxFsBridge(workspace),
            [Symbol.dispose]: dispose,
          },
        });
      });
      const context = resolveMediaGenerateToolContext(
        "imageGenerationProviders",
        {
          config,
          agentSessionKey: `agent:${requesterAgentId}:cron:generated:run:current`,
          sandboxSessionKey: "agent:main:policy",
          sandboxAgentId: "main",
          requesterAgentId,
          workspaceDir: "/closed/projection",
          spawnWorkspaceDir: "/canonical/worktree",
          skillsSnapshot,
          sandbox,
        },
        { warn: vi.fn(), error: vi.fn() },
        true,
      );
      if (!context) {
        throw new Error("Expected a media tool context");
      }
      expect(context.taskOptions()).toMatchObject({
        requesterAgentId,
        sessionKey: `agent:${requesterAgentId}:cron:generated:run:current`,
      });
      const result = await buildMediaGenerateToolExecutionResult({
        ...params,
        sandbox: context.acquireOutputSandbox,
      });
      expect(resolveSandboxContext).toHaveBeenCalledWith({
        config,
        sessionKey: "agent:main:policy",
        agentId: "main",
        workspaceDir: "/canonical/worktree",
        skillsSnapshot,
        execOverrides: undefined,
        assertCurrent: expect.any(Function),
      });
      const [relativePath] = result.details.sandboxPaths as string[];
      if (!relativePath) {
        throw new Error("Expected a sandbox path after reacquisition");
      }
      await expect(fs.readFile(path.join(workspace, relativePath))).resolves.toEqual(png);
      expect(originalWrite).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();

      const otherWorkspace = tempDirs.make("other-sandbox-");
      resolveSandboxContext.mockResolvedValue(
        createSandboxTestContext({
          overrides: {
            workspaceDir: otherWorkspace,
            fsBridge: createHostSandboxFsBridge(otherWorkspace),
            [Symbol.dispose]: dispose,
          },
        }),
      );
      const refused = await buildMediaGenerateToolExecutionResult({
        ...params,
        sandbox: context.acquireOutputSandbox,
      });
      expect(refused.details.sandboxPaths).toBeUndefined();
      expect(refused.wakeResult).toContain("Sandbox copy unavailable");
      await expect(fs.readdir(otherWorkspace)).resolves.toEqual([]);
      expect(dispose).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "read-only before completion",
    "no-access before completion",
    "workspace before completion",
    "backend before completion",
    "limit before completion",
    "reload during acquisition",
    "reload after gitignore",
    "unrelated reload",
  ])("revalidates foreground staging policy: %s", async (transition) => {
    const { workspace, sandbox, params } = await fixture();
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } },
        entries: { main: { workspace }, work: { workspace } },
      },
    };
    setRuntimeConfigSnapshot(config);
    const context = resolveMediaGenerateToolContext(
      "imageGenerationProviders",
      {
        config,
        agentSessionKey: "agent:work:generated",
        sandboxSessionKey: "agent:main:policy",
        sandboxAgentId: "main",
        requesterAgentId: "work",
        spawnWorkspaceDir: workspace,
        sandbox,
      },
      { warn: vi.fn(), error: vi.fn() },
      true,
    );
    if (!context) {
      throw new Error("Expected a media tool context");
    }
    const replacement: OpenClawConfig = structuredClone(config);
    if (transition.startsWith("workspace")) {
      replacement.agents!.entries!.work!.workspace = path.join(workspace, "replacement");
    } else if (transition.startsWith("backend")) {
      replacement.agents!.defaults!.sandbox!.backend = "podman";
    } else if (transition.startsWith("limit")) {
      replacement.agents!.defaults!.mediaMaxMb = 1;
    } else if (transition === "unrelated reload") {
      replacement.logging = { level: "debug" };
    } else {
      replacement.agents!.defaults!.sandbox!.workspaceAccess = transition.startsWith("no-access")
        ? "none"
        : "ro";
    }
    const dispose = vi.fn();
    const write = sandbox.bridge.createFileExclusive!.bind(sandbox.bridge);
    const written = vi
      .spyOn(sandbox.bridge, "createFileExclusive")
      .mockImplementation(async (args) => {
        const result = await write(args);
        if (transition === "reload after gitignore") {
          setRuntimeConfigSnapshot(replacement);
        }
        return result;
      });
    resolveSandboxContext.mockImplementation(async () => {
      if (transition === "reload during acquisition") {
        setRuntimeConfigSnapshot(replacement);
      }
      return createSandboxTestContext({
        overrides: {
          workspaceDir: workspace,
          fsBridge: sandbox.bridge,
          [Symbol.dispose]: dispose,
        },
      });
    });
    if (transition.endsWith("before completion") || transition === "unrelated reload") {
      setRuntimeConfigSnapshot(replacement);
    }
    const result = await buildMediaGenerateToolExecutionResult({
      ...params,
      sandbox: context.acquireOutputSandbox,
    });
    expect(result.attachments).toEqual(params.attachments);
    expect(result.details.paths).toEqual(params.mediaUrls);
    if (transition === "unrelated reload") {
      expect(result.details.sandboxPaths).toHaveLength(1);
      expect(resolveSandboxContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ config: replacement }),
      );
      expect(written).toHaveBeenCalledTimes(2);
    } else {
      expect(result.details.sandboxPaths).toBeUndefined();
      expect(result.wakeResult).toContain(
        "Sandbox copy unavailable: Error: The requesting sandbox configuration has changed",
      );
      expect(written).toHaveBeenCalledTimes(transition === "reload after gitignore" ? 1 : 0);
    }
    if (transition.startsWith("reload ") || transition === "unrelated reload") {
      expect(dispose).toHaveBeenCalledOnce();
    }
  });

  it("refuses to reuse a captured bridge without a sandbox session", async () => {
    const { workspace, sandbox, params } = await fixture();
    setRuntimeConfigSnapshot({});
    const context = resolveMediaGenerateToolContext(
      "imageGenerationProviders",
      { config: {}, sandbox },
      { warn: vi.fn(), error: vi.fn() },
      true,
    );
    const result = await buildMediaGenerateToolExecutionResult({
      ...params,
      sandbox: context?.acquireOutputSandbox,
    });
    expect(result.details.sandboxPaths).toBeUndefined();
    expect(result.wakeResult).toContain("The requesting sandbox session is unavailable");
    await expect(fs.readdir(workspace)).resolves.toEqual([]);
  });
});
