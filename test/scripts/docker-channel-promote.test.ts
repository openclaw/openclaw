import { describe, expect, it, vi } from "vitest";
import {
  createDockerChannelPromotionPlan,
  parseDockerChannelPromotionArgs,
  promoteDockerChannel,
} from "../../scripts/docker-channel-promote.mjs";

const images = ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"];
const digest = `sha256:${"1".repeat(64)}`;

describe("Docker channel promotion", () => {
  it("plans every extended-stable image variant in both registries", () => {
    expect(createDockerChannelPromotionPlan({ version: "2026.6.33", images })).toEqual({
      channel: "extended-stable",
      promotions: images.flatMap((image) => [
        {
          image,
          sourceRef: `${image}:2026.6.33`,
          targetRefs: [`${image}:extended-stable`],
        },
        {
          image,
          sourceRef: `${image}:2026.6.33-slim`,
          targetRefs: [`${image}:extended-stable-slim`],
        },
        {
          image,
          sourceRef: `${image}:2026.6.33-browser`,
          targetRefs: [`${image}:extended-stable-browser`],
        },
      ]),
      version: "2026.6.33",
    });
  });

  it("preflights every source before moving and verifying aliases", () => {
    const calls: string[][] = [];
    const targetDigests = new Map<string, string>();
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (args[2] === "inspect") {
        return JSON.stringify({ digest: targetDigests.get(args[3]!) ?? digest });
      }
      const sourceDigest = args.at(-1)!.split("@")[1]!;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--tag") {
          targetDigests.set(args[index + 1]!, sourceDigest);
        }
      }
      return "";
    });

    promoteDockerChannel({ version: "2026.6.33", images }, { execFileSyncImpl });

    const firstCreate = calls.findIndex((args) => args[2] === "create");
    expect(firstCreate).toBe(6);
    expect(calls.slice(0, firstCreate).every((args) => args[2] === "inspect")).toBe(true);
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(6);
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "docker",
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        "ghcr.io/openclaw/openclaw:extended-stable",
        `ghcr.io/openclaw/openclaw@${digest}`,
      ],
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it("fails without mutating when any immutable source is missing", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 3) {
        throw new Error("missing manifest");
      }
      return JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel({ version: "2026.6.33", images }, { execFileSyncImpl }),
    ).toThrow("missing manifest");
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when a promoted alias does not match its immutable source", () => {
    const wrongDigest = `sha256:${"2".repeat(64)}`;
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args[2] === "inspect" && args[3]?.endsWith(":extended-stable")) {
        return JSON.stringify({ digest: wrongDigest });
      }
      return args[2] === "inspect" ? JSON.stringify({ digest }) : "";
    });

    expect(() =>
      promoteDockerChannel({ version: "2026.6.33", images }, { execFileSyncImpl }),
    ).toThrow(`resolved to ${wrongDigest}, expected ${digest}`);
  });

  it("rejects channels without moving aliases", () => {
    expect(() => createDockerChannelPromotionPlan({ version: "2026.7.2-beta.3", images })).toThrow(
      "no moving aliases",
    );
  });

  it("parses repeated image arguments", () => {
    expect(
      parseDockerChannelPromotionArgs([
        "--version",
        "2026.6.33",
        "--image",
        images[0]!,
        "--image",
        images[1]!,
      ]),
    ).toEqual({ help: false, images, version: "2026.6.33" });
  });
});
