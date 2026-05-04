import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import { recordInboundSession } from "./session.js";

describe("recordInboundSession", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createCaseDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recordInboundSession-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("persists delivery route from OriginatingChannel and OriginatingTo when updateLastRoute is omitted", async () => {
    const dir = await createCaseDir("mattermost-group");
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, "{}", "utf-8");
    const sessionKey = "agent:main:mattermost:group:room123";
    const ctx = {
      OriginatingChannel: "mattermost",
      OriginatingTo: "channel:room123",
      Provider: "mattermost",
      AccountId: "default",
      MessageThreadId: "thread-77",
    };

    await recordInboundSession({
      storePath,
      sessionKey,
      ctx,
      onRecordError: () => undefined,
    });

    const store = loadSessionStore(storePath);
    expect(store[sessionKey]?.deliveryContext).toEqual({
      channel: "mattermost",
      to: "channel:room123",
      accountId: "default",
      threadId: "thread-77",
    });
  });

  it("falls back to Provider/To when Originating fields are absent", async () => {
    const dir = await createCaseDir("provider-to");
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, "{}", "utf-8");
    const sessionKey = "agent:main:matrix:group:room999";
    const ctx = {
      Provider: "matrix",
      To: "room:room999",
      Surface: "matrix",
    };

    await recordInboundSession({
      storePath,
      sessionKey,
      ctx,
      onRecordError: () => undefined,
    });

    const store = loadSessionStore(storePath);
    expect(store[sessionKey]?.deliveryContext).toEqual({
      channel: "matrix",
      to: "room:room999",
    });
  });
});
