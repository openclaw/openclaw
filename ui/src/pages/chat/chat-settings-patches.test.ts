/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { createResolvedModelPatch, sessionListResult } from "../../test-helpers/chat-model.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { row } from "./chat-outbox-recovery.test-support.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retires a failed queued picker back to the preceding confirmed session row", async () => {
  const firstPatch = createDeferred<unknown>();
  const firstPatchStarted = createDeferred();
  let patchCount = 0;
  const host = makeChatHost({
    requestHandlers: {
      "sessions.list": sessionListResult(0, [
        row("agent:main", {
          model: "gpt-5-mini",
          modelProvider: "openai",
          modelOverrideSource: "user",
        }),
      ]),
      "sessions.patch": () => {
        patchCount += 1;
        if (patchCount === 1) {
          firstPatchStarted.resolve();
          return firstPatch.promise;
        }
        throw new Error("picker rejected");
      },
    },
  });

  const slash = patchChatSessionSettings(host, host.sessionKey, { model: "openai/gpt-5-mini" });
  // The first patch can still be loading the lazy session mutation runtime.
  await awaitGateBeforeSettlement(
    firstPatchStarted.promise,
    slash,
    "First settings patch settled before reaching sessions.patch",
  );
  expect(patchCount).toBe(1);
  const picker = patchChatSessionSettings(host, host.sessionKey, {
    model: "openai/gpt-5",
  });

  expect(host.sessions.state.modelOverrides[host.sessionKey]).toBe("openai/gpt-5-mini");
  firstPatch.resolve(createResolvedModelPatch("gpt-5-mini", "openai"));
  await expect(slash).resolves.toBeTruthy();
  await expect(picker).rejects.toThrow("picker rejected");
  expect(host.sessions.state.modelOverrides[host.sessionKey]).toBeUndefined();
  expect(host.sessions.state.result?.sessions[0]).toMatchObject({
    model: "gpt-5-mini",
    modelProvider: "openai",
    modelOverrideSource: "user",
  });
});
