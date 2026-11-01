import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("offers interrupt separately from steering and preserves the other queued message", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [{ role: "user", content: "Review the release checklist", timestamp: 1 }],
          sessionId: "session:agent:main:main",
          sessionInfo: {
            key: "agent:main:main",
            sessionId: "session:agent:main:main",
            hasActiveRun: true,
            activeRunIds: ["active-run"],
            status: "running",
          },
          inFlightRun: {
            runId: "active-run",
            text: "Checking the current release notes…",
            startedAt: Date.now(),
          },
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    const preference = page.locator("[data-settings-follow-up-mode]");
    await preference.waitFor();
    await preference.selectOption("queue");
    const stage = process.env.OPENCLAW_INTERRUPT_PROOF_STAGE ?? "after";
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      if (stage !== "before") {
        await preference.selectOption("interrupt");
      }
      await preference.scrollIntoViewIfNeeded();
      const frame = await takeControlUiScreenshotFrame(page, preference, [preference], {
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, `${stage}-preferences.png`), frame.png);
    }
    await preference.selectOption("queue");
    const options = await preference
      .locator("option")
      .evaluateAll((items) => items.map((item) => item.getAttribute("value")));
    await page.goto(`${suite.server.baseUrl}chat`);
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.waitFor();
    for (const message of ["Check the security section first", "Then update the migration guide"]) {
      await composer.fill(message);
      await composer.press("Enter");
      await page.locator(".chat-queue__item", { hasText: message }).waitFor();
    }
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const queue = page.locator(".chat-queue");
      const frame = await takeControlUiScreenshotFrame(
        page,
        queue,
        [queue.locator(".chat-queue__text").first()],
        { animations: "disabled", elements: [queue] },
      );
      await writeFile(path.join(suite.artifactDir, `${stage}-queue.png`), frame.png);
      await writeFile(
        path.join(suite.artifactDir, `${stage}-context.json`),
        JSON.stringify({
          viewport: page.viewportSize(),
          fixture: "mocked Gateway, real Control UI",
          options,
        }),
      );
    }
    expect(options).toContain("interrupt");
    const selected = page.locator(".chat-queue__item", {
      hasText: "Check the security section first",
    });
    await selected
      .getByRole("button", { name: "Interrupt & send queued message", exact: true })
      .click();
    const requests = await gateway.waitForRequest("chat.send");
    expect(requests.params).toMatchObject({
      message: "Check the security section first",
      queueMode: "interrupt",
    });
    expect(
      await page
        .locator(".chat-queue__item", { hasText: "Then update the migration guide" })
        .count(),
    ).toBe(1);
  });
  it("controls original Gateway custody without sending the message again", async () => {
    const page = await newChatPage(suite);
    const pending = ["one", "two"].map((id, index) => ({
      id,
      runId: `queued-${id}`,
      acceptedAt: index + 1,
      state: "queued",
      queued: true,
      message: { role: "user", content: `Accepted queued message ${id}` },
    }));
    const history = {
      messages: [],
      sessionId: "session:agent:main:main",
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session:agent:main:main",
        hasActiveRun: true,
        activeRunIds: ["active-run"],
        status: "running",
      },
      inFlightRun: { runId: "active-run", text: "Still working", startedAt: Date.now() },
      pendingInputs: { items: pending, total: 2, queuedCount: 2 },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": history,
        "chat.startup": history,
        "chat.interrupt": { status: "queued", runId: "queued-one", cancellationRequested: true },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const row = page.locator(".chat-queue__item", { hasText: "Accepted queued message one" });
    await row.getByRole("button", { name: "Interrupt & send queued message", exact: true }).click();
    const request = await gateway.waitForRequest("chat.interrupt");
    expect(request.params).toMatchObject({
      sessionKey: "agent:main:main",
      sessionId: "session:agent:main:main",
      runId: "queued-one",
    });
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    expect(
      await page.locator(".chat-queue__item", { hasText: "Accepted queued message two" }).count(),
    ).toBe(1);
  });
});
