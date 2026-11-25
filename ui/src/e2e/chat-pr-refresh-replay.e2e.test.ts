import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
} from "../../../src/gateway/control-ui-contract.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails, openDetailsPullRequests } from "./chat-details.test-support.ts";
import { newChatPage } from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { createLightDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "PR refresh replay through the Control UI",
  trackBrowserContexts: true,
});
suite.define(() => {
  it("refreshes the first stream and distinct finals without replaying a completed refresh", async () => {
    const page = await newChatPage(suite, createLightDesktopControlUiContextOptions());
    const gateway = await installMockGateway(page, {
      assistantName: "Review fixture",
      agentModel: "openai/gpt-5.6-sol",
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" }],
      presenceUsers: [{ id: "synthetic-reviewer", name: "Synthetic Reviewer", self: true }],
      featureMethods: ["chat.metadata", "chat.startup", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
      methodResponses: { [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true } },
    });
    const nextFrame = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
    await page.goto(`${suite.server.baseUrl}chat`);
    const key = await waitForWatchedSessionKey(gateway);
    const pullRequest = {
      number: 111532,
      owner: "openclaw",
      repo: "openclaw",
      branch: "fixture/review-refresh",
      title: "Synthetic review refresh proof",
      url: "https://github.com/openclaw/openclaw/pull/111532",
      state: "open",
    };
    const snapshot = async (state: string) => {
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [key]: {
            pullRequests: [{ ...pullRequest, state }],
            rateLimited: false,
            status: "ok",
          },
        },
      });
      await expect
        .poll(() => page.locator(".chat-pr").first().getAttribute("data-state"))
        .toBe(state);
    };
    await openChatDetails(page);
    await snapshot("open");
    await openDetailsPullRequests(page);
    const forceRequests = async () =>
      (await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD)).filter((request) => {
        const params = request.params as { refreshSessionKeys?: string[] } | undefined;
        return params?.refreshSessionKeys?.includes(key);
      });
    const initialForces = (await forceRequests()).length;
    const runId = "synthetic-pr-review-run";
    const text = `Opened ${pullRequest.url}`;
    await gateway.emitGatewayEvent("chat", {
      sessionKey: key,
      runId,
      state: "delta",
      deltaText: text,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    await expect.poll(async () => (await forceRequests()).length).toBe(initialForces + 1);
    const final = {
      sessionKey: key,
      runId,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
    await gateway.emitGatewayEvent("chat", final);
    await expect.poll(async () => (await forceRequests()).length).toBe(initialForces + 2);
    // The next frame cannot share the earlier request's microtask batch.
    await nextFrame();
    await gateway.emitGatewayEvent("chat", final);
    await nextFrame();
    const afterReplay = (await forceRequests()).length - initialForces;
    const mergedText = `Merged ${pullRequest.url}`;
    await gateway.emitGatewayEvent("chat", {
      ...final,
      message: { role: "assistant", content: [{ type: "text", text: mergedText }] },
    });
    // A distinct final is a positive delivery barrier after the replay.
    await expect
      .poll(async () => (await forceRequests()).length)
      .toBe(initialForces + afterReplay + 1);
    await snapshot("merged");
    await page.getByText(mergedText, { exact: false }).first().waitFor();
    const requests = (await forceRequests()).slice(initialForces);
    expect(
      requests.map(
        (request) => (request.params as { refreshSessionKeys: string[] }).refreshSessionKeys,
      ),
    ).toEqual([[key], [key], [key]]);
    expect(afterReplay).toBe(2);
  });
});
