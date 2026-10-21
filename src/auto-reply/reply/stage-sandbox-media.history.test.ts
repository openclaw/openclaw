import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import {
  createSandboxMediaContexts,
  createSandboxWorkspacePreparation,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome as withHome,
} from "../stage-sandbox-media.test-harness.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

const workspace = vi.hoisted(() => vi.fn());
// mock-isolation: History rewriting owns synthetic workspaces without provisioning real sandboxes.
vi.mock("../../agents/sandbox/context.js", () => ({
  ensureSandboxWorkspaceForSession: workspace,
  prepareSandboxWorkspaceForSession: async (...args: unknown[]) =>
    createSandboxWorkspacePreparation(await workspace(...args)),
}));
beforeEach(() => workspace.mockReset());
const read = (root: string, file: string) => fs.readFile(path.resolve(root, file), "utf8");

async function mediaFixture(home: string) {
  const source = path.join(home, ".openclaw", "media", "inbound", "synthetic.png");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "image");
  return {
    source,
    ...createSandboxMediaContexts(source),
    cfg: createSandboxMediaStageConfig(home),
    sessionKey: "agent:main:main",
    workspaceDir: path.join(home, "workspace"),
  };
}

it.each(["settled", "failed", "aborted"] as const)(
  "awaits attribution before staging: %s",
  (outcome) =>
    withHome("attribution-media-", async (home) => {
      const fixture = await mediaFixture(home);
      const { workspaceDir } = fixture;
      workspace.mockResolvedValue(null);
      const entered = createDeferred();
      const baseline = createDeferred();
      const controller = new AbortController();
      const failure = new Error("capture no longer active");
      const pending = stageSandboxMedia({
        ...fixture,
        abortSignal: controller.signal,
        awaitSessionDiffBaseline: () => {
          entered.resolve();
          return baseline.promise;
        },
      });
      void pending.catch(() => {});
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "Media bypassed attribution");
        expect(workspace).not.toHaveBeenCalled();
        await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
        if (outcome === "aborted") {
          controller.abort(failure);
        }
        if (outcome === "failed") {
          baseline.reject(failure);
        } else {
          baseline.resolve();
        }
        if (outcome !== "settled") {
          await expect(pending).rejects.toBe(failure);
        } else {
          expect(await read(workspaceDir, (await pending).staged.get(0)!)).toBe("image");
        }
        expect(workspace).toHaveBeenCalledTimes(outcome === "settled" ? 1 : 0);
      } finally {
        baseline.resolve();
        await pending.catch(() => undefined);
      }
    }),
);

describe.each([false, true])("history (sandbox=%s)", (sandbox) => {
  it.each(["path-only", "physical-alias", "managed-alias", "file-alias"])(
    "keeps %s images fetchable",
    (reference) =>
      withHome("staged-history-", async (home) => {
        const fixture = await mediaFixture(home);
        const { source, ctx, sessionCtx } = fixture;
        const uri = "media://inbound/synthetic.png";
        const root = path.join(home, sandbox ? "sandbox" : "workspace");
        workspace.mockResolvedValue(
          sandbox ? { workspaceDir: root, containerWorkdir: "/work" } : null,
        );
        const mediaPath = reference === "managed-alias" ? uri : source;
        const url =
          reference === "path-only"
            ? undefined
            : reference === "file-alias"
              ? pathToFileURL(source).href
              : mediaPath;
        ctx.media = [{ path: mediaPath, url, contentType: "image/png", kind: "image" }];
        const result = await stageSandboxMedia(fixture);
        const stagedPath = result.staged.get(0)!;
        expect(stagedPath).not.toBe(source);
        expect(await read(root, stagedPath)).toBe("image");
        expect(sessionCtx.media).toEqual(ctx.media);

        const [history] = sanitizeChatHistoryMessages([
          buildPersistedUserTurnMessage({ text: "attachment", media: ctx.media }),
        ]);
        expect(history).toMatchObject({
          __openclaw: { media: [{ url: uri, contentType: "image/png", kind: "image" }] },
        });
        expect(JSON.stringify(history)).not.toContain(home);
        expect(JSON.stringify(history)).not.toContain("openclaw-staged-");
      }),
  );
});
