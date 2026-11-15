import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { hydratePromptMediaMessages } from "../../agents/embedded-agent-runner/run/images.js";
import { createHostSandboxFsBridge } from "../../agents/test-helpers/host-sandbox-fs-bridge.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import { STAGED_INPUT_MAX_BYTES } from "../../media/staged-inputs.js";
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

async function mediaFixture(home: string, sandbox = false) {
  const source = path.join(home, ".openclaw", "media", "inbound", "synthetic.png");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "image");
  const root = path.join(home, sandbox ? "sandbox" : "workspace");
  workspace.mockResolvedValue(sandbox ? { workspaceDir: root, containerWorkdir: "/work" } : null);
  return {
    source,
    root,
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

it.each([
  [false, "path-only"],
  [true, "path-only"],
  [true, "physical-alias"],
  [true, "managed-alias"],
  [true, "file-alias"],
] as const)("keeps images fetchable (sandbox=%s, reference=%s)", (sandbox, reference) =>
  withHome("staged-history-", async (home) => {
    const fixture = await mediaFixture(home, sandbox);
    const { source, root, ctx, sessionCtx } = fixture;
    const uri = "media://inbound/synthetic.png";
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

it.each(["present", "missing", "outside-root"] as const)(
  "replays a staged photo on a later sandbox turn: %s",
  (copy) =>
    withHome("staged-history-replay-", async (home) => {
      const fixture = await mediaFixture(home, true);
      let { root } = fixture;
      const photo = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
      await fs.writeFile(fixture.source, photo);
      fixture.ctx.media = [{ path: fixture.source, contentType: "image/png" }];
      const { staged } = await stageSandboxMedia(fixture);
      const message = buildPersistedUserTurnMessage({
        text: "Describe this photo",
        media: fixture.ctx.media,
      });
      const serialized = JSON.stringify(message);
      const replay = JSON.parse(serialized) as typeof message;
      const stagedPath = path.resolve(root, staged.get(0)!);
      if (copy === "missing") {
        await fs.rm(stagedPath);
      } else if (copy === "outside-root") {
        root = path.join(home, "other-sandbox");
        await fs.mkdir(root);
      }

      const result = await hydratePromptMediaMessages(
        [replay, buildPersistedUserTurnMessage({ text: "What color was it?" })],
        {
          workspaceDir: root,
          workspaceOnly: true,
          model: { input: ["text", "image"] },
          sandbox: { root, bridge: createHostSandboxFsBridge(root) },
        },
      );

      expect(result[0]).toHaveProperty("content", [
        { type: "text", text: "Describe this photo" },
        ...(copy === "present"
          ? [{ type: "image", data: photo.toString("base64"), mimeType: "image/png" }]
          : []),
      ]);
    }),
);

it.each(["copied", "missing"] as const)(
  "requires an accepted ZIP at the turn barrier: %s",
  (outcome) =>
    withHome("managed-zip-stage-", async (home) => {
      const fixture = await mediaFixture(home, true);
      const source = path.join(path.dirname(fixture.source), "input.zip");
      const bytes = Buffer.from("504b05060000000000000000000000000000000000000000", "hex");
      await fs.writeFile(source, bytes);
      fixture.ctx.media = [
        { path: source, url: "media://inbound/input.zip", contentType: "application/zip" },
      ];
      if (outcome === "missing") {
        await fs.rm(source);
        await expect(stageSandboxMedia(fixture)).rejects.toThrow("Failed to prepare attachments");
      } else {
        const result = await stageSandboxMedia(fixture);
        expect(await fs.readFile(path.resolve(fixture.root, result.staged.get(0)!))).toEqual(bytes);
        expect(fixture.ctx.media[0]?.url).toBe("media://inbound/input.zip");
      }
    }),
);

it.each(["pdf", "zip", "aborted"] as const)(
  "handles workspace preparation failure for managed %s",
  (kind) =>
    withHome("managed-stage-failure-", async (home) => {
      const fixture = await mediaFixture(home, true);
      const controller = new AbortController();
      const reason = new Error("staging stopped");
      fixture.ctx.media = [
        {
          path: fixture.source,
          url: `media://inbound/input.${kind === "aborted" ? "pdf" : kind}`,
          contentType: kind === "zip" ? "application/zip" : "application/pdf",
        },
      ];
      workspace.mockImplementationOnce(async () => {
        if (kind === "aborted") {
          controller.abort(reason);
          throw reason;
        }
        throw kind === "zip"
          ? new DOMException("Aborted", "AbortError")
          : new Error("synthetic workspace unavailable");
      });
      const pending = stageSandboxMedia({ ...fixture, abortSignal: controller.signal });
      await expect(pending).rejects.toThrow(
        kind === "aborted"
          ? reason.message
          : kind === "zip"
            ? "Attachment workspace preparation was interrupted"
            : "synthetic workspace unavailable",
      );
    }),
);

it("keeps the managed PDF host path when the workspace copy exceeds the staging cap", () =>
  withHome("managed-pdf-fallback-", async (home) => {
    const fixture = await mediaFixture(home, true);
    const size = STAGED_INPUT_MAX_BYTES + 1;
    await fs.writeFile(fixture.source, "%PDF-1.4\n");
    await fs.truncate(fixture.source, size);
    fixture.ctx.media = [
      { path: fixture.source, url: "media://inbound/input.pdf", contentType: "application/pdf" },
    ];
    expect((await stageSandboxMedia(fixture)).staged.size).toBe(0);
    expect(fixture.ctx.media[0]?.path).toBe(fixture.source);
    expect((await fs.stat(fixture.source)).size).toBe(size);
  }));
