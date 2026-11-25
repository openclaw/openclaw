import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as mediaRoots from "../../media/channel-inbound-roots.js";
import * as exec from "../../process/exec.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { withOpenClawTestState as withState } from "../../test-utils/openclaw-test-state.js";
import { stageRemoteInboundMediaIfNeeded } from "./stage-remote-inbound-media.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { agentId: "work", remoteMediaMode: "sandbox-or-cache" },
  { agentId: undefined, remoteMediaMode: "cache" },
] as const)(
  "retries remote global media for $agentId ($remoteMediaMode)",
  ({ agentId, remoteMediaMode }) =>
    withState({ label: "remote-media-owner" }, async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: {}, work: {} },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode: "all" as const,
              scope: "agent" as const,
              workspaceRoot: state.path("sandbox"),
            },
          },
        },
        session: { scope: "global" as const },
      };
      vi.spyOn(mediaRoots, "resolveChannelRemoteInboundAttachmentRoots").mockReturnValue([
        "/attachments",
      ]);
      let scpAttempts = 0;
      const runScp = vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv) => {
        const retrying = ++scpAttempts === 1;
        if (!retrying) {
          await fs.writeFile(argv.at(-1)!, "remote attachment");
        }
        return createCommandResult({
          code: retrying ? 1 : 0,
          stderr: retrying ? "remote attachment is still materializing" : "",
        });
      });
      const ctx = {
        MediaRemoteHost: "user@gateway-host",
        media: [{ path: "/attachments/report.txt" }],
      };
      const params = { ctx, cfg, agentId, sessionKey: "global", remoteMediaMode };
      const stage = (workspaceDir: string) =>
        stageRemoteInboundMediaIfNeeded({ ...params, workspaceDir });
      expect(await stage(state.path(`${agentId}-workspace`))).toBe(true);
      expect(runScp).toHaveBeenCalledTimes(2);
      const fact = ctx.media[0] as { path: string; workspaceDir?: string; staged?: boolean };
      expect(fact.staged).toBe(true);
      const staged = path.isAbsolute(fact.path)
        ? fact.path
        : path.join(fact.workspaceDir!, fact.path);
      try {
        expect(await fs.readFile(staged, "utf8")).toBe("remote attachment");
        expect(path.isAbsolute(fact.path)).toBe(remoteMediaMode === "cache");
        if (remoteMediaMode === "cache") {
          expect(fact.workspaceDir).toContain(path.join("media", "remote-cache"));
        } else {
          expect(fact.workspaceDir?.startsWith(state.path("sandbox"))).toBe(true);
        }
        expect(await stage(state.workspaceDir)).toBe(false);
      } finally {
        // Cache mode uses the test harness's process root; remove only this call's input directory.
        if (remoteMediaMode === "cache") {
          await fs.rm(path.dirname(staged), { recursive: true, force: true });
        }
      }
    }),
);
