import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaParams,
  resolveMatrixAutoThreadId,
} from "./message-action-params.js";

const cfg = {} as OpenClawConfig;
const maybeIt = process.platform === "win32" ? it.skip : it;

describe("message action sandbox media hydration", () => {
  maybeIt("rejects symlink retarget escapes after sandbox media normalization", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-sandbox-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-outside-"));
    try {
      const insideDir = path.join(sandboxRoot, "inside");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "note.txt"), "INSIDE_SECRET", "utf8");
      await fs.writeFile(path.join(outsideRoot, "note.txt"), "OUTSIDE_SECRET", "utf8");

      const slotLink = path.join(sandboxRoot, "slot");
      await fs.symlink(insideDir, slotLink);

      const args: Record<string, unknown> = {
        media: "slot/note.txt",
      };
      const mediaPolicy = {
        mode: "sandbox",
        sandboxRoot,
      } as const;

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy,
      });

      await fs.rm(slotLink, { recursive: true, force: true });
      await fs.symlink(outsideRoot, slotLink);

      await expect(
        hydrateAttachmentParamsForAction({
          cfg,
          channel: "slack",
          args,
          action: "sendAttachment",
          mediaPolicy,
        }),
      ).rejects.toThrow(/outside workspace root|outside/i);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveMatrixAutoThreadId (#32744)", () => {
  it("returns thread ID when target room matches current room", () => {
    expect(
      resolveMatrixAutoThreadId({
        to: "!abc123:example.org",
        toolContext: {
          currentThreadTs: "$ev1",
          currentChannelId: "!abc123:example.org",
        },
      }),
    ).toBe("$ev1");
  });

  it("handles room: prefix on channel ID", () => {
    expect(
      resolveMatrixAutoThreadId({
        to: "!abc123:example.org",
        toolContext: {
          currentThreadTs: "$ev2",
          currentChannelId: "room:!abc123:example.org",
        },
      }),
    ).toBe("$ev2");
  });

  it("returns undefined when rooms differ", () => {
    expect(
      resolveMatrixAutoThreadId({
        to: "!other:example.org",
        toolContext: {
          currentThreadTs: "$ev3",
          currentChannelId: "!abc123:example.org",
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no thread context", () => {
    expect(
      resolveMatrixAutoThreadId({
        to: "!abc123:example.org",
        toolContext: undefined,
      }),
    ).toBeUndefined();
  });
});
