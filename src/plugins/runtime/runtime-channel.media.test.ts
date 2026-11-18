import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createCtx } from "../../channels/turn/run-channel-turn.delivery.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeChannel } from "./runtime-channel.js";

it("exposes scoped attachment retirement through the actual channel runtime", async () => {
  await withOpenClawTestState({ label: "runtime-media-retirement" }, async (state) => {
    const media = createRuntimeChannel().media;
    const saved = await media.saveMediaBuffer(Buffer.from("attachment"), "text/plain");
    const neighbor = await media.saveMediaBuffer(Buffer.from("keep"), "text/plain");
    expect(saved.path.startsWith(state.stateDir + path.sep)).toBe(true);
    expect(await fs.readFile(saved.path, "utf8")).toBe("attachment");
    await expect(media.deleteMediaBuffer(`../${neighbor.id}`)).rejects.toThrow();
    expect(await fs.readFile(neighbor.path, "utf8")).toBe("keep");
    await media.deleteMediaBuffer(saved.id);
    await expect(fs.stat(saved.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(neighbor.path, "utf8")).toBe("keep");
  });
});

it("keeps accepted inbound media readable when downstream dispatch rejects", async () => {
  await withOpenClawTestState({ label: "runtime-media-dispatch" }, async () => {
    const failure = new Error("downstream dispatch failed");
    let readByDispatcher: string | undefined;
    const channel = createRuntimeChannel({
      dispatchReplyFromConfig: async ({ ctx }) => {
        const mediaPath = ctx.media?.[0]?.path;
        if (!mediaPath) {
          throw new Error("expected accepted structured media path");
        }
        readByDispatcher = await fs.readFile(mediaPath, "utf8");
        throw failure;
      },
    });
    const saved = await channel.media.saveMediaBuffer(
      Buffer.from("accepted attachment"),
      "text/plain",
    );
    const sessionKey = "agent:main:nextcloud-talk:direct:media-test";
    await expect(
      channel.inbound.dispatch({
        cfg: {},
        channel: "nextcloud-talk",
        accountId: "default",
        route: { agentId: "main", sessionKey },
        ctxPayload: createCtx({
          SessionKey: sessionKey,
          Provider: "nextcloud-talk",
          Surface: "nextcloud-talk",
          CommandAuthorized: false,
          media: [{ path: saved.path, contentType: "text/plain", kind: "document" }],
        }),
        delivery: { deliver: async () => undefined },
      }),
    ).rejects.toBe(failure);
    expect(readByDispatcher).toBe("accepted attachment");
    expect(await fs.readFile(saved.path, "utf8")).toBe("accepted attachment");
  });
});
