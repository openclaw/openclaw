/** Post-seed inbound media staging through the SSH sandbox's remote filesystem owner. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSandbox } from "../agents/sandbox/fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "../agents/sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../agents/sandbox/remote-fs-bridge.test-helpers.js";
import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";
import {
  createSandboxMediaContexts,
  withSandboxMediaTempHome,
} from "./stage-sandbox-media.test-harness.js";

const sandboxMocks = vi.hoisted(() => ({
  resolveSandboxContext: vi.fn(),
  ensureSandboxWorkspaceForSession: vi.fn(),
}));
vi.mock("../agents/sandbox.js", () => sandboxMocks);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("SSH post-seed inbound staging", () => {
  it.each(["rw", "none", "ro"] as const)(
    "stages through the remote bridge with workspaceAccess=%s",
    async (workspaceAccess) => {
      await withSandboxMediaTempHome("openclaw-ssh-media-", async (home) => {
        const localWorkspace = path.join(home, "gateway-workspace");
        const remoteWorkspace = path.join(await fs.realpath(tempDirs.make("ssh-media-")), "remote");
        await fs.mkdir(localWorkspace, { recursive: true });
        await fs.mkdir(remoteWorkspace);
        // Model the already-seeded remote workspace independently from Gateway storage.
        // The real remote bridge scripts, source policy and staging owner run below.
        await fs.writeFile(path.join(remoteWorkspace, "seeded.txt"), "first turn");
        const calls: string[] = [];
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir: localWorkspace,
            agentWorkspaceDir: localWorkspace,
            workspaceAccess,
            containerWorkdir: remoteWorkspace,
          }),
          runtime: {
            remoteWorkspaceDir: remoteWorkspace,
            remoteAgentWorkspaceDir: remoteWorkspace,
            runRemoteShellScript: createLocalRemoteShellScriptRunner({
              onCommand: (command) => calls.push(command.script),
            }),
          },
        });
        sandboxMocks.resolveSandboxContext.mockReset().mockResolvedValue({
          workspaceDir: localWorkspace,
          fsBridge: bridge,
        });
        sandboxMocks.ensureSandboxWorkspaceForSession.mockClear();

        const inboundDir = path.join(home, ".openclaw", "media", "inbound");
        await fs.mkdir(inboundDir, { recursive: true });
        const source = path.join(inboundDir, "photo.png");
        const payload = Buffer.from("second-turn-image");
        await fs.writeFile(source, payload);
        const { ctx, sessionCtx } = createSandboxMediaContexts(source);
        const skillsSnapshot =
          workspaceAccess === "rw"
            ? {
                prompt: "",
                skills: [],
                librarySelections: [
                  {
                    skillId: "00000000-0000-0000-0000-000000000001",
                    revision: "0".repeat(64),
                    name: "private-proof",
                    ownerProfileId: "private-profile",
                  },
                ],
              }
            : undefined;

        const result = await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg: { agents: { defaults: { sandbox: { backend: "ssh" } } } },
          sessionKey: "agent:main:chat",
          workspaceDir: localWorkspace,
          skillsSnapshot,
        });

        expect(sandboxMocks.resolveSandboxContext).toHaveBeenCalledExactlyOnceWith({
          config: { agents: { defaults: { sandbox: { backend: "ssh" } } } },
          agentId: undefined,
          sessionKey: "agent:main:chat",
          workspaceDir: localWorkspace,
          skillsSnapshot,
        });
        expect(sandboxMocks.ensureSandboxWorkspaceForSession).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(remoteWorkspace, "seeded.txt"), "utf8")).toBe(
          "first turn",
        );
        if (workspaceAccess === "ro") {
          expect(result.staged.size).toBe(0);
          expect(ctx.media?.[0]?.path).toBe(source);
          expect(await fs.readdir(remoteWorkspace)).toEqual(["seeded.txt"]);
          expect(await fs.readdir(localWorkspace)).toEqual([]);
          return;
        }

        const staged = result.staged.get(0);
        expect(staged).toMatch(/^media\/inbound\/openclaw-staged-[\da-f-]+\/input-photo\.png$/u);
        expect(ctx.media?.[0]).toMatchObject({ path: staged, staged: true });
        expect(sessionCtx.media?.[0]).toMatchObject({ path: staged, staged: true });
        expect(await bridge.readFile({ filePath: staged! })).toEqual(payload);
        expect(sha256(await fs.readFile(path.join(remoteWorkspace, staged!)))).toBe(
          sha256(payload),
        );
        expect(
          await fs.readFile(
            path.join(remoteWorkspace, path.dirname(staged!), ".gitignore"),
            "utf8",
          ),
        ).toContain("Raw task inputs remain private");
        expect(await fs.readdir(localWorkspace)).toEqual([]);
        expect(calls.length).toBeGreaterThan(0);
      });
    },
  );
});
