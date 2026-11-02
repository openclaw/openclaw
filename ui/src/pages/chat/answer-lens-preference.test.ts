import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  readAnswerLensPreference,
  rememberAnswerLensPreference,
} from "./answer-lens-preference.ts";
import { AnswerLens, ORIGINAL_LENS } from "./answer-lens.ts";

const source = { messageId: "latest", text: "A detailed explanation. ".repeat(12) };
const preference = { coverage: "gist", wording: "plain" } as const;
function setup() {
  const request = vi
    .fn<GatewayBrowserClient["request"]>()
    .mockImplementation(async (_method, params) => ({
      ...params,
      text: "Rewritten",
      sourceRevision: "revision",
      durationMs: 1,
    }));
  const client = { request };
  const owner = new AnswerLens();
  const configure = (sessionKey: string, latestMessageId = source.messageId) =>
    owner.configure({ client, sessionKey, latestMessageId });
  configure("first");
  return { owner, request, configure };
}

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
afterEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  rememberAnswerLensPreference(ORIGINAL_LENS);
  vi.unstubAllGlobals();
});

describe("remembered Answer Lens selection", () => {
  it("inherits explicit choices in new sessions and after recreating the owner", async () => {
    const first = setup();
    await first.owner.select(source, preference);
    expect(readAnswerLensPreference()).toEqual(preference);
    first.configure("second");
    first.request.mockClear();
    await first.owner.applyRemembered(source);
    expect(first.request.mock.calls[1]?.[1]).toMatchObject(preference);
    const reloaded = setup();
    await reloaded.owner.applyRemembered(source);
    expect(reloaded.request.mock.calls[1]?.[1]).toMatchObject(preference);
  });

  it("only admits the latest answer once, and never retries a failed automatic rewrite", async () => {
    const { owner, request, configure } = setup();
    await owner.select(source, preference);
    configure("second");
    request.mockClear();
    await owner.applyRemembered({ ...source, messageId: "historical" });
    expect(request).not.toHaveBeenCalled();
    request.mockRejectedValueOnce(new Error("Unavailable"));
    await owner.applyRemembered(source);
    await owner.applyRemembered(source);
    expect(request).toHaveBeenCalledTimes(1);
    expect(owner.read(source)?.error).toContain("Unavailable");
    configure("second", "new-answer");
    await owner.applyRemembered({ ...source, messageId: "new-answer" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("Original clears the inherited rewrite without calling the model", async () => {
    const { owner, configure } = setup();
    await owner.select(source, preference);
    await owner.select(source, ORIGINAL_LENS);
    configure("second");
    const reloaded = setup();
    await reloaded.owner.applyRemembered(source);
    expect(reloaded.request).not.toHaveBeenCalled();
    expect(readAnswerLensPreference()).toEqual(ORIGINAL_LENS);
  });

  it("keeps short answers full without changing the remembered length", async () => {
    const { owner, request, configure } = setup();
    await owner.select(source, preference);
    configure("second");
    request.mockClear();
    await owner.applyRemembered({
      ...source,
      text: "A short but eligible explanation. ".repeat(3),
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({ coverage: "full", wording: "plain" });
    expect(readAnswerLensPreference()).toEqual(preference);
  });

  it("does not let an old readable preference override a selection whose storage write failed", async () => {
    const { owner, request, configure } = setup();
    await owner.select(source, ORIGINAL_LENS);
    const store = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: store.getItem.bind(store),
      setItem() {
        throw new Error("quota");
      },
    });
    await owner.select(source, preference);
    configure("second");
    request.mockClear();
    await owner.applyRemembered(source);
    expect(request.mock.calls[1]?.[1]).toMatchObject(preference);
  });

  it("ignores malformed storage and keeps a same-owner preference when storage is denied", async () => {
    localStorage.setItem(
      "openclaw.control.answerLens.v1",
      '{"coverage":"gist","wording":"original"}',
    );
    expect(readAnswerLensPreference()).toBeUndefined();
    const { owner, request, configure } = setup();
    vi.stubGlobal("localStorage", undefined);
    await owner.select(source, preference);
    configure("second");
    request.mockClear();
    await owner.applyRemembered(source);
    expect(request.mock.calls[1]?.[1]).toMatchObject(preference);
  });
});
